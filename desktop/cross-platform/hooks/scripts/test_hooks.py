"""Lightweight tests for hook scripts."""

import importlib
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

codex_hook = importlib.import_module('codex_hook')
common = importlib.import_module('common')
setup_hooks = importlib.import_module('setup_hooks')


def call_quietly(func, *args, **kwargs):
    with redirect_stdout(StringIO()):
        return func(*args, **kwargs)


class CodexHookTests(unittest.TestCase):
    def test_event_aliases_cover_expected_codex_names(self):
        self.assertEqual(codex_hook.EVENT_ALIASES['post_tool_use'], 'PostToolUse')
        self.assertEqual(codex_hook.EVENT_ALIASES['session_start'], 'SessionStart')
        self.assertEqual(codex_hook.EVENT_ALIASES['stop_failure'], 'StopFailure')


class CommonPathTests(unittest.TestCase):
    def test_resolve_base_dir_prefers_pet_base_dir(self):
        self.assertEqual(
            common.resolve_base_dir({'pet_base_dir': 'pets/kotori'}, '/repo'),
            '/repo/pets/kotori',
        )
        self.assertEqual(common.resolve_base_dir({}, '/repo'), '/repo')

    def test_resolve_path_from_base_uses_pet_base_dir_for_relative_sessions_dir(self):
        self.assertEqual(
            common.resolve_path_from_base(
                'runtime/custom-sessions',
                '/repo/pets/kotori',
                'desktop',
                'cross-platform',
                'runtime',
                'sessions',
            ),
            '/repo/pets/kotori/runtime/custom-sessions',
        )
        self.assertEqual(
            common.resolve_path_from_base(
                None,
                '/repo/pets/kotori',
                'desktop',
                'cross-platform',
                'runtime',
                'sessions',
            ),
            '/repo/pets/kotori/desktop/cross-platform/runtime/sessions',
        )


class SetupHooksTests(unittest.TestCase):
    def test_install_event_hooks_replaces_managed_entries_and_keeps_foreign_ones(self):
        target = setup_hooks.HookTarget(
            name='Codex',
            settings_path='/tmp/hooks.json',
            command='/repo/desktop/cross-platform/hooks/pet-hook.sh codex',
            events=['Stop'],
        )
        settings = {
            'hooks': {
                'Stop': [
                    {'hooks': [{'command': 'echo keep-me', 'type': 'command'}]},
                    {'hooks': [{'command': 'hooks/pet-codex-hook.sh', 'type': 'command'}]},
                    {'hooks': [{'command': target.command, 'type': 'command'}]},
                ]
            }
        }

        call_quietly(setup_hooks.install_event_hooks, settings, target)

        stop_hooks = settings['hooks']['Stop']
        self.assertEqual(len(stop_hooks), 2)
        self.assertEqual(stop_hooks[0]['hooks'][0]['command'], 'echo keep-me')
        self.assertEqual(stop_hooks[1]['hooks'][0]['command'], target.command)

    def test_setup_platform_writes_expected_hook_config(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            settings_path = Path(temp_dir) / 'hooks.json'
            target = setup_hooks.HookTarget(
                name='Claude Code',
                settings_path=str(settings_path),
                command='/repo/desktop/cross-platform/hooks/pet-hook.sh claude-code',
                events=['SessionStart', 'Stop'],
            )

            call_quietly(setup_hooks.setup_platform, target)

            written = json.loads(settings_path.read_text())
            self.assertEqual(set(written['hooks'].keys()), {'SessionStart', 'Stop'})
            for event_name in target.events:
                self.assertEqual(
                    written['hooks'][event_name],
                    [{'hooks': [{'command': target.command, 'type': 'command'}]}],
                )

    def test_enable_codex_pet_hooks_marks_existing_trusted_entries_enabled(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            settings_path = Path(temp_dir) / 'hooks.json'
            config_toml = Path(temp_dir) / 'config.toml'
            hook_cmd = '/repo/desktop/cross-platform/hooks/pet-hook.sh codex'
            settings = {
                'hooks': {
                    'Stop': [{'hooks': [{'command': hook_cmd, 'type': 'command'}]}]
                }
            }
            settings_path.write_text(json.dumps(settings))

            state_key = setup_hooks.codex_hook_state_key(str(settings_path), 'Stop', 0, 0)
            config_toml.write_text(
                f'[hooks.state."{state_key}"]\ntrusted_hash = "abc123"\n'
            )

            call_quietly(
                setup_hooks.enable_codex_pet_hooks,
                str(settings_path),
                hook_cmd,
                ['Stop'],
            )

            text = config_toml.read_text()
            self.assertIn('enabled = true', text)
            self.assertIn('trusted_hash = "abc123"', text)


if __name__ == '__main__':
    unittest.main()
