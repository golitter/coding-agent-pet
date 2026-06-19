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
    def test_shell_entrypoints_use_lf_line_endings(self):
        platform_dir = SCRIPT_DIR.parent.parent
        shell_files = [
            platform_dir / 'hooks' / 'pet-hook.sh',
            platform_dir / 'scripts' / 'macos' / 'common.sh',
            platform_dir / 'scripts' / 'macos' / 'setup.sh',
            platform_dir / 'scripts' / 'macos' / 'setup-hooks.sh',
            platform_dir / 'scripts' / 'macos' / 'build-and-run.sh',
            platform_dir / 'scripts' / 'wsl' / 'setup-hooks.sh',
        ]

        for shell_file in shell_files:
            with self.subTest(path=shell_file):
                data = shell_file.read_bytes()
                self.assertNotIn(b'\r\n', data)

    def test_windows_entrypoints_use_crlf_line_endings(self):
        scripts_dir = SCRIPT_DIR.parent.parent / 'scripts' / 'windows'
        powershell_files = [
            scripts_dir / 'common.ps1',
            scripts_dir / 'setup.ps1',
            scripts_dir / 'setup-hooks.ps1',
            scripts_dir / 'build-and-run.ps1',
        ]

        for powershell_file in powershell_files:
            with self.subTest(path=powershell_file):
                data = powershell_file.read_bytes()
                self.assertIn(b'\r\n', data)
                self.assertNotIn(b'\n', data.replace(b'\r\n', b''))

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

    def test_build_targets_uses_python_scripts_on_wsl(self):
        platform_dir = Path('/mnt/d/repo/desktop/cross-platform')
        original_is_windows = setup_hooks.is_windows
        original_is_wsl = setup_hooks.is_wsl
        original_detect_python_command = setup_hooks.detect_python_command
        try:
            setup_hooks.is_windows = lambda: False
            setup_hooks.is_wsl = lambda: True
            setup_hooks.detect_python_command = lambda _config=None: 'python3'

            targets, _hooks_config, _python_command = setup_hooks.build_targets(
                platform_dir,
                {'hooks': {}},
            )
        finally:
            setup_hooks.is_windows = original_is_windows
            setup_hooks.is_wsl = original_is_wsl
            setup_hooks.detect_python_command = original_detect_python_command

        commands = {target.name: target.command for target in targets}
        self.assertEqual(
            commands['Claude Code'],
            'python3 /mnt/d/repo/desktop/cross-platform/hooks/scripts/claude_hook.py',
        )
        self.assertEqual(
            commands['Codex'],
            'python3 /mnt/d/repo/desktop/cross-platform/hooks/scripts/codex_hook.py',
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

    def test_build_command_quotes_windows_style_paths(self):
        command = setup_hooks.build_command([
            r'C:\Program Files\Python\python.exe',
            r'C:\repo with spaces\hooks\scripts\codex_hook.py',
        ])
        self.assertEqual(
            command,
            r'"C:\Program Files\Python\python.exe" "C:\repo with spaces\hooks\scripts\codex_hook.py"',
        )

    def test_config_path_or_default_treats_null_as_auto_detect(self):
        self.assertEqual(
            setup_hooks.config_path_or_default(None, '/default/path'),
            '/default/path',
        )

    def test_detect_python_command_env_overrides_config_value(self):
        original_env = os.environ.get('KOTORI_PET_PYTHON')
        original_validate = setup_hooks.validate_python_command
        try:
            os.environ['KOTORI_PET_PYTHON'] = 'python3'
            setup_hooks.validate_python_command = lambda command: command == 'python3'
            self.assertEqual(
                setup_hooks.detect_python_command('C:/Windows/Python/python.exe'),
                'python3',
            )
        finally:
            setup_hooks.validate_python_command = original_validate
            if original_env is None:
                os.environ.pop('KOTORI_PET_PYTHON', None)
            else:
                os.environ['KOTORI_PET_PYTHON'] = original_env

    def test_should_setup_opencode_honors_skip_env(self):
        original = os.environ.get('KOTORI_PET_SKIP_OPENCODE')
        try:
            os.environ['KOTORI_PET_SKIP_OPENCODE'] = '1'
            self.assertFalse(setup_hooks.should_setup_opencode())
            os.environ['KOTORI_PET_SKIP_OPENCODE'] = 'false'
            self.assertTrue(setup_hooks.should_setup_opencode())
        finally:
            if original is None:
                os.environ.pop('KOTORI_PET_SKIP_OPENCODE', None)
            else:
                os.environ['KOTORI_PET_SKIP_OPENCODE'] = original

    def test_setup_opencode_deploys_plugin_shared_module_and_companion(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            platform_dir = Path(temp_dir) / 'desktop' / 'cross-platform'
            hooks_dir = platform_dir / 'hooks'
            plugins_dir = Path(temp_dir) / 'opencode' / 'plugins'
            hooks_dir.mkdir(parents=True)
            (hooks_dir / 'opencode-plugin.ts').write_text(
                'import "./opencode-shared.mjs";\n',
                encoding='utf-8',
            )
            (hooks_dir / 'opencode-shared.mjs').write_text(
                'export const marker = true;\n',
                encoding='utf-8',
            )

            deployed = call_quietly(
                setup_hooks.setup_opencode,
                platform_dir,
                {'opencode_plugins_dir': str(plugins_dir)},
            )

            self.assertEqual(deployed, str(plugins_dir / 'pet-plugin.ts'))
            self.assertTrue((plugins_dir / 'pet-plugin.ts').exists())
            self.assertTrue((plugins_dir / 'opencode-shared.mjs').exists())
            self.assertEqual(
                (plugins_dir / '.kotori-pet-config-dir').read_text(encoding='utf-8'),
                str(platform_dir.resolve()),
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
