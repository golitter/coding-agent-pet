"""Lightweight tests for hook scripts."""

import importlib
import json
import os
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


def norm(path):
    return str(Path(path))


def call_quietly(func, *args, **kwargs):
    with redirect_stdout(StringIO()):
        return func(*args, **kwargs)


class CodexHookTests(unittest.TestCase):
    def test_event_aliases_cover_expected_codex_names(self):
        self.assertEqual(codex_hook.EVENT_ALIASES['post_tool_use'], 'PostToolUse')
        self.assertEqual(codex_hook.EVENT_ALIASES['session_start'], 'SessionStart')
        self.assertEqual(codex_hook.EVENT_ALIASES['stop_failure'], 'StopFailure')


class CommonPathTests(unittest.TestCase):
    def test_load_config_reads_utf8_dialogue_on_windows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            platform_dir = Path(temp_dir) / 'desktop' / 'cross-platform'
            platform_dir.mkdir(parents=True)
            config_path = platform_dir / 'config.json'
            config_path.write_text(
                json.dumps({
                    'pet_id': 'kotori-minami',
                    'state_map': {
                        'Stop': {'state': 'jumping', 'dialogue': '搞定啦！'}
                    },
                }, ensure_ascii=False),
                encoding='utf-8',
            )

            config, repo_root = common.load_config(str(platform_dir))

            self.assertEqual(repo_root, str(Path(temp_dir)))
            self.assertEqual(config['state_map']['Stop']['dialogue'], '搞定啦！')

    def test_resolve_base_dir_prefers_pet_base_dir(self):
        self.assertEqual(
            common.resolve_base_dir({'pet_base_dir': 'pets/kotori'}, '/repo'),
            norm('/repo/pets/kotori'),
        )
        self.assertEqual(common.resolve_base_dir({}, '/repo'), norm('/repo'))

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
            norm('/repo/pets/kotori/runtime/custom-sessions'),
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
            norm('/repo/pets/kotori/desktop/cross-platform/runtime/sessions'),
        )


class SetupHooksTests(unittest.TestCase):
    def test_install_event_hooks_replaces_managed_entries_and_keeps_foreign_ones(self):
        target = setup_hooks.HookTarget(
            name='Codex',
            settings_path='/tmp/hooks.json',
            command='/repo/desktop/cross-platform/hooks/pet-hook.sh codex',
            events=['Stop'],
            executable_names=['codex'],
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
                executable_names=['claude'],
            )

            call_quietly(setup_hooks.setup_platform, target)

            written = json.loads(settings_path.read_text())
            self.assertEqual(set(written['hooks'].keys()), {'SessionStart', 'Stop'})
            for event_name in target.events:
                self.assertEqual(
                    written['hooks'][event_name],
                    [{'hooks': [{'command': target.command, 'type': 'command'}]}],
                )

    def test_setup_platform_writes_codex_windows_command_when_present(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            settings_path = Path(temp_dir) / 'hooks.json'
            target = setup_hooks.HookTarget(
                name='Codex',
                settings_path=str(settings_path),
                command='python3 /mnt/d/repo/codex_hook.py',
                events=['Stop'],
                executable_names=['codex'],
                command_windows=r'python D:\repo\codex_hook.py',
            )

            call_quietly(setup_hooks.setup_platform, target)

            hook = json.loads(settings_path.read_text())['hooks']['Stop'][0]['hooks'][0]
            self.assertEqual(hook['command'], 'python3 /mnt/d/repo/codex_hook.py')
            self.assertEqual(hook['commandWindows'], r'python D:\repo\codex_hook.py')

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

    def test_build_command_quotes_windows_style_paths(self):
        command = setup_hooks.build_command([
            r'C:\Program Files\Python\python.exe',
            r'C:\repo with spaces\hooks\scripts\codex_hook.py',
        ])
        self.assertEqual(
            command,
            r'"C:\Program Files\Python\python.exe" "C:\repo with spaces\hooks\scripts\codex_hook.py"',
        )

    def test_windows_path_to_wsl_converts_drive_paths(self):
        if os.name != 'nt':
            self.skipTest('Windows path conversion only')
        converted = setup_hooks.windows_path_to_wsl(r'D:\repo with spaces\hook.py')
        self.assertEqual(converted, '/mnt/d/repo with spaces/hook.py')

    def test_build_wsl_hook_command_uses_forward_slash_paths(self):
        if os.name != 'nt':
            self.skipTest('Windows path conversion only')
        command = setup_hooks.build_wsl_hook_command(r'D:\repo with spaces\hook.py')
        self.assertEqual(command, 'python3 "/mnt/d/repo with spaces/hook.py"')

    def test_config_path_or_default_treats_null_as_auto_detect(self):
        self.assertEqual(
            setup_hooks.config_path_or_default(None, '/default/path'),
            '/default/path',
        )


class EndpointTests(unittest.TestCase):
    def test_default_event_endpoint_prefers_explicit_value(self):
        self.assertEqual(
            common.default_event_endpoint({'event_endpoint': 'tcp://127.0.0.1:9999'}),
            'tcp://127.0.0.1:9999',
        )

    def test_default_event_endpoint_uses_socket_path_on_non_windows(self):
        if os.name == 'nt':
            self.skipTest('non-Windows default only')
        self.assertEqual(
            common.default_event_endpoint({'socket_path': '/tmp/custom.sock'}),
            '/tmp/custom.sock',
        )


if __name__ == '__main__':
    unittest.main()
