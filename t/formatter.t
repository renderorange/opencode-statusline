#!/usr/bin/perl

# Regression tests for bin/opencode-statusline.  The plugin side (tui.tsx) needs the
# OpenCode host and is not covered here; this pins the formatter's output byte for byte.
#
# Run with: prove -r t   (or npm test)

use strict;
use warnings;

use Cwd          ();
use File::Basename ();
use File::Spec   ();
use File::Temp   ();
use IPC::Open2   ();
use JSON::PP     ();
use Test::More;

my $ROOT   = File::Basename::dirname( File::Basename::dirname( Cwd::abs_path($0) ) );
my $SCRIPT = File::Spec->catfile( $ROOT, 'bin', 'opencode-statusline' );

my $HOME       = File::Temp::tempdir( CLEANUP => 1 );
my $CONFIG_DIR = File::Temp::tempdir( CLEANUP => 1 );
my $WORK       = File::Temp::tempdir( CLEANUP => 1 );

# A stable escape for the muted colour, as the formatter emits it
my $MUTED = "\e[90m";
my $PLAIN = "\e[39m";

# Feeds JSON to the formatter and returns everything it prints.  HOME and the config path
# are pinned so the output does not depend on the machine running the tests.
sub run_formatter {
    my ( $input, $config ) = @_;

    my $path = File::Spec->catfile( $CONFIG_DIR, 'config.jsonc' );

    if ( defined $config ) {
        open( my $handle, '>:encoding(UTF-8)', $path ) or die "can't write config: $!";
        print {$handle} $config;
        close($handle) or die "can't close config: $!";
    }
    else {
        unlink $path;
    }

    local %ENV = (
        %ENV,
        HOME                       => $HOME,
        XDG_CONFIG_HOME            => $CONFIG_DIR,
        OPENCODE_STATUSLINE_CONFIG => $path,
    );

    my ( $reader, $writer );
    my $pid = IPC::Open2::open2( $reader, $writer, $SCRIPT );

    print {$writer} $input;
    close($writer);

    local $/;
    my $output = <$reader>;

    close($reader);
    waitpid( $pid, 0 );

    return defined $output ? $output : '';
}

# JSON is built rather than pasted, so a stray quote cannot quietly change a test
sub payload {
    my ($data) = @_;

    return JSON::PP->new->canonical->encode($data);
}

sub test_config {
    my ($data) = @_;

    return JSON::PP->new->canonical->encode($data);
}

my $dir = File::Spec->catdir( $HOME, 'project' );

# The default layout: folder, then the bracket group, with the branch left out because
# this is not a git checkout
is(
    run_formatter( payload( { workspace => { current_dir => $dir } } ) ),
    "~/project\n",
    'default layout draws the folder and drops the empty sections'
);

is(
    run_formatter( payload( { cwd => $dir } ) ),
    "~/project\n",
    'top-level cwd is accepted in place of workspace.current_dir'
);

# Percent rounding happens before the color threshold is compared, and before display
is(
    run_formatter(
        payload( { workspace => { current_dir => $dir }, context_window => { used_percentage => 12.4 } } ),
        test_config( { sections => ['context'], labels => { context => '' } } )
    ),
    "12%\n",
    'context percent is rounded for display'
);

is(
    run_formatter( payload( { workspace => { current_dir => $dir } } ), test_config( { sections => ['context'], labels => { context => '' } } ) ),
    "\n",
    'a section with no value prints as an empty line'
);

# Token counts: 999,999 must read 1M, never 1000k
is(
    run_formatter(
        payload(
            {   workspace      => { current_dir => $dir },
                context_window => { used_percentage => 16, used_tokens => 163_000, limit_tokens => 1_000_000 },
            }
        ),
        test_config( { sections => ['context'], labels => { context => '' }, context => { tokens => 1 } } )
    ),
    "16%${MUTED} 163k/1M${PLAIN}\n",
    'token counts follow the percent, in the muted colour'
);

is(
    run_formatter(
        payload(
            {   workspace      => { current_dir => $dir },
                context_window => { used_percentage => 100, used_tokens => 999_999, limit_tokens => 1_000_000 },
            }
        ),
        test_config( { sections => ['context'], labels => { context => '' }, context => { tokens => 1 } } )
    ),
    "100%${MUTED} 1M/1M${PLAIN}\n",
    'a count that rounds up at the boundary reads 1M, not 1000k'
);

is(
    run_formatter(
        payload(
            {   workspace      => { current_dir => $dir },
                context_window => { used_percentage => 16, used_tokens => 963 },
            }
        ),
        test_config( { sections => ['context'], labels => { context => '' }, context => { tokens => 1 } } )
    ),
    "16%${MUTED} 963${PLAIN}\n",
    'without a limit only the used count is shown'
);

# Time, squished
is(
    run_formatter(
        payload( { workspace => { current_dir => $dir }, cost => { total_duration_ms => 272_000 } } ),
        test_config( { sections => ['time'], labels => { time => '' } } )
    ),
    "4m32s\n",
    'duration squishes to minutes and seconds'
);

is(
    run_formatter(
        payload( { workspace => { current_dir => $dir }, cost => { total_duration_ms => 3_930_000 } } ),
        test_config( { sections => ['time'], labels => { time => '' } } )
    ),
    "1h5m30s\n",
    'duration includes hours once there are any'
);

# Muted section and muted separator
is(
    run_formatter(
        payload( { workspace => { current_dir => $dir }, cost => { total_duration_ms => 272_000 } } ),
        test_config( { sections => ['time'], labels => { time => '' }, muted => ['time'] } )
    ),
    "${MUTED}4m32s${PLAIN}\n",
    'a muted section is drawn in bright black'
);

is(
    run_formatter(
        payload(
            {   workspace      => { current_dir => $dir },
                context_window => { used_percentage => 10 },
                cost           => { total_duration_ms => 62_000 },
            }
        ),
        test_config(
            {   sections => [ { sections => [ 'context', 'time' ], separator => ' - ', muted_separator => 1 } ],
                labels   => { context => '', time => '' },
            }
        )
    ),
    "10%${MUTED} - ${PLAIN}1m2s\n",
    'muted_separator dims only the text between the group sections'
);

# Colour thresholds: highest reached "at" wins, as a 24-bit foreground
is(
    run_formatter(
        payload( { workspace => { current_dir => $dir }, context_window => { used_percentage => 30 } } ),
        test_config(
            {   sections => ['context'],
                labels   => { context => '' },
                colors   => {
                    context => [
                        { color => '#ff3030', at => 20 },
                        { color => '#ff8700', at => 35 },
                    ],
                },
            }
        )
    ),
    "\e[38;2;255;48;48m30%\e[39m\n",
    'the highest reached threshold colours the section'
);

is(
    run_formatter(
        payload( { workspace => { current_dir => $dir }, context_window => { used_percentage => 10 } } ),
        test_config(
            {   sections => ['context'],
                labels   => { context => '' },
                colors   => { context => [ { color => '#ff3030', at => 20 } ] },
            }
        )
    ),
    "10%\n",
    'below every threshold the section keeps the terminal colour'
);

# Cache hit rate derived from the last request's token counts
is(
    run_formatter(
        payload(
            {   workspace      => { current_dir => $dir },
                context_window => {
                    used_percentage   => 10,
                    current_usage     => {
                        cache_read_input_tokens     => 90,
                        cache_creation_input_tokens => 10,
                        input_tokens                => 0,
                    },
                },
            }
        ),
        test_config( { sections => ['cache'], labels => { cache => '' } } )
    ),
    "90%\n",
    'cache rate comes from the token counts when no ratio is sent'
);

is(
    run_formatter(
        payload( { workspace => { current_dir => $dir }, prompt_cache => { hit_ratio => 0.5 } } ),
        test_config( { sections => ['cache'], labels => { cache => '' } } )
    ),
    "50%\n",
    'a sent hit ratio overrides the derived one'
);

# Custom command sections
is(
    run_formatter(
        payload( { workspace => { current_dir => $WORK } } ),
        test_config( { sections => ['echo'], commands => { echo => { run => 'printf hello' } } } )
    ),
    "hello\n",
    'a command section prints its first output line'
);

is(
    run_formatter(
        payload( { workspace => { current_dir => $WORK } } ),
        test_config( { sections => ['echo'], commands => { echo => { run => 'echo one; echo two' } } } )
    ),
    "one\n",
    'only the first line of a command is used'
);

is(
    run_formatter(
        payload( { workspace => { current_dir => $WORK } } ),
        test_config( { sections => ['echo'], commands => { echo => { run => 'printf silent; exit 1' } } } )
    ),
    "\n",
    'a command that fails contributes nothing'
);

is(
    run_formatter(
        payload( { workspace => { current_dir => $WORK } } ),
        test_config( { sections => ['echo'], commands => { echo => { run => q{printf '%s' 'a\b'} } } } )
    ),
    "a\\b\n",
    'a backslash in a command survives to its output'
);

# Config errors replace the line rather than breaking the TUI
like(
    run_formatter( payload( { workspace => { current_dir => $dir } } ), '{"nope": 1}' ),
    qr/^opencode-statusline: .*unknown setting "nope"\n$/,
    'an unknown setting is reported in place of the line'
);

like(
    run_formatter( payload( { workspace => { current_dir => $dir } } ), '{"sections": ["nope"]}' ),
    qr/^opencode-statusline: .*unknown section "nope"/,
    'an unknown section is reported in place of the line'
);

like(
    run_formatter( payload( { workspace => { current_dir => $dir } } ), '{"sections": [' ),
    qr/^opencode-statusline: .*not valid JSON/,
    'a config that will not parse is reported in place of the line'
);

# The formatter always exits 0: the plugin shows stdout, and a non-zero exit would be
# indistinguishable from a missing script
is( run_formatter('not json at all'), "\n", 'invalid input JSON is not fatal' );

done_testing();