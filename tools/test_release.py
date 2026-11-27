"""Tests for the pure functions in tools/release.py. No network, no build, no push.

Run: py -3 -m unittest discover tools
"""
import contextlib
import io
import json
import shutil
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import release

THUMB = "a1b2c3d4e5f60718293a4b5c6d7e8f9011223344"
FAKE_TOKEN = "fake-token-0123456789abcdef"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
# Test files stay inside the project (tests/.tmp is git-ignored), never in the system temp folder.
TMP = release.ROOT / "tests" / ".tmp" / "release"


def fresh_folder(name):
    folder = TMP / name
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    return folder


def quiet_fail(test, function, *args):
    """Runs `function`, expects fail() and returns what it printed to stderr."""
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr), test.assertRaises(SystemExit):
        function(*args)
    return stderr.getvalue()


class WindowsSigningConfigTest(unittest.TestCase):
    def test_no_variables_means_unsigned(self):
        self.assertIsNone(release.windows_signing_config({}))

    def test_thumbprint_with_default_timestamp(self):
        config = release.windows_signing_config({"HANGAR_NOTE_CERT_THUMBPRINT": THUMB})
        self.assertEqual(
            config["bundle"]["windows"],
            {
                "certificateThumbprint": THUMB.upper(),
                "digestAlgorithm": "sha256",
                "timestampUrl": "http://time.certum.pl",
                "tsp": True,
            },
        )

    def test_hangar_variables_do_not_count(self):
        self.assertIsNone(release.windows_signing_config({"HANGAR_CERT_THUMBPRINT": THUMB}))

    def test_invalid_thumbprint_without_value_in_message(self):
        with self.assertRaises(release.SigningError) as caught:
            release.windows_signing_config({"HANGAR_NOTE_CERT_THUMBPRINT": "secret-looking-value"})
        self.assertNotIn("secret-looking-value", str(caught.exception))

    def test_both_variants_exclude_each_other(self):
        env = {"HANGAR_NOTE_CERT_THUMBPRINT": THUMB, "HANGAR_NOTE_SIGN_COMMAND": '["a", "%1"]'}
        with self.assertRaises(release.SigningError):
            release.windows_signing_config(env)

    def test_sign_command_as_argv(self):
        env = {"HANGAR_NOTE_SIGN_COMMAND": '["C:/Program Files/sign.exe", "sign", "%1"]'}
        self.assertEqual(
            release.windows_signing_config(env),
            {"bundle": {"windows": {"signCommand": {"cmd": "C:/Program Files/sign.exe", "args": ["sign", "%1"]}}}},
        )

    def test_sign_command_as_shell_string_rejected(self):
        with self.assertRaises(release.SigningError):
            release.windows_signing_config({"HANGAR_NOTE_SIGN_COMMAND": "signtool sign %1"})

    def test_timestamp_url_and_tsp(self):
        env = {
            "HANGAR_NOTE_CERT_THUMBPRINT": THUMB,
            "HANGAR_NOTE_TIMESTAMP_URL": "https://ts.example.org/rfc3161",
            "HANGAR_NOTE_TIMESTAMP_TSP": "0",
        }
        windows = release.windows_signing_config(env)["bundle"]["windows"]
        self.assertEqual((windows["timestampUrl"], windows["tsp"]), ("https://ts.example.org/rfc3161", False))
        with self.assertRaises(release.SigningError):
            release.windows_signing_config({**env, "HANGAR_NOTE_TIMESTAMP_TSP": "2"})


class UnsignedTest(unittest.TestCase):
    def test_unsigned_build_needs_the_flag(self):
        self.assertIn("--allow-unsigned", release.unsigned_build_problem(None, False))
        self.assertIsNone(release.unsigned_build_problem(None, True))
        self.assertIsNone(release.unsigned_build_problem({"bundle": {}}, False))

    def test_unsigned_publish_aborts_without_the_flag(self):
        with mock.patch.object(release, "authenticode_problem", return_value="signature status NotSigned"):
            message = quiet_fail(self, release.require_signature, Path("x.exe"), False)
            self.assertIn("--allow-unsigned", message)
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertFalse(release.require_signature(Path("x.exe"), True))
            self.assertIn("WARNING", out.getvalue())

    def test_signed_installer_passes(self):
        with mock.patch.object(release, "authenticode_problem", return_value=None), contextlib.redirect_stdout(
            io.StringIO()
        ):
            self.assertTrue(release.require_signature(Path("x.exe"), False))

    def test_signature_report(self):
        self.assertIsNone(release.signature_problem('{"Status":"Valid","Timestamped":true}'))
        self.assertIn("NotSigned", release.signature_problem('{"Status":"NotSigned","Timestamped":false}'))
        self.assertIn("timestamp", release.signature_problem('{"Status":"Valid","Timestamped":false}'))
        self.assertIn("not readable", release.signature_problem("garbage"))

    def test_unsigned_notes_warn_users(self):
        entry = {"version": "0.1.0", "items": [{"en": "First release.", "de": "Erste Version."}]}
        self.assertEqual(release.release_notes(entry, True), "- First release.")
        self.assertIn("SHA256SUMS.txt", release.release_notes(entry, False))


class EnvironmentTest(unittest.TestCase):
    def test_secrets_never_reach_child_processes(self):
        env = {
            "PATH": "p",
            "forgejo_token": "x",
            "NPM_TOKEN": "x",
            "GH_TOKEN": "x",
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": "x",
            "HANGAR_NOTE_CERT_THUMBPRINT": THUMB,
            "HANGAR_NOTE_SIGN_COMMAND": "[]",
        }
        self.assertEqual(release.without_secrets(env), {"PATH": "p"})
        self.assertEqual(release.without_secrets(env, keep=("GH_TOKEN",)), {"PATH": "p", "GH_TOKEN": "x"})

    def test_git_keeps_ssh_settings_only_for_network_calls(self):
        env = {"PATH": "p", "GIT_DIR": "elsewhere", "GIT_SSH_COMMAND": "ssh -i k", "FORGEJO_TOKEN": "x"}
        self.assertEqual(release.git_environment(env), {"PATH": "p"})
        self.assertEqual(release.git_environment(env, allow_ssh=True), {"PATH": "p", "GIT_SSH_COMMAND": "ssh -i k"})


class DotenvTest(unittest.TestCase):
    def test_parser_reads_plain_pairs_only(self):
        text = (
            "# comment\n"
            "\n"
            "FORGEJO_TOKEN=fake-value-1\n"
            "export FORGEJO_URL = \"https://forge.example.invalid\"\n"
            "QUOTED='a b'\n"
            "NOT A KEY=1\n"
            "no_equals_sign\n"
            "EXPANDED=$HOME/x\n"
        )
        self.assertEqual(
            release.parse_env_text(text),
            {
                "FORGEJO_TOKEN": "fake-value-1",
                "FORGEJO_URL": "https://forge.example.invalid",
                "QUOTED": "a b",
                "EXPANDED": "$HOME/x",
            },
        )

    def test_inline_comments_end_unquoted_values_only(self):
        text = 'A=fake-a # note\nB="fake #b" # note\nC=fake#c\nD=\'x\' trailing\n'
        self.assertEqual(
            release.parse_env_text(text), {"A": "fake-a", "B": "fake #b", "C": "fake#c", "D": "x"}
        )

    def test_crlf_and_bom(self):
        folder = fresh_folder("dotenv")
        (folder / ".env").write_bytes("\ufeffFORGEJO_TOKEN=fake-value-2\r\nB=2\r\n".encode("utf-8"))
        self.assertEqual(release.read_dotenv(folder / ".env"), {"FORGEJO_TOKEN": "fake-value-2", "B": "2"})
        self.assertEqual(release.read_dotenv(folder / "missing.env"), {})

    def test_token_from_environment_then_dotenv(self):
        settings = release.forgejo_settings({"FORGEJO_TOKEN": "from-env"}, {"FORGEJO_TOKEN": "from-file"}, "h.invalid")
        self.assertEqual((settings.token, settings.token_source), ("from-env", "FORGEJO_TOKEN from environment"))
        settings = release.forgejo_settings({}, {"FORGEJO_TOKEN": "from-file"}, "h.invalid")
        self.assertEqual((settings.token, settings.token_source), ("from-file", "FORGEJO_TOKEN from .env"))
        self.assertIsNone(release.forgejo_settings({"OTHER_TOKEN": "x"}, {}, "h.invalid").token)

    def test_url_order_and_fallback_without_ssh_port(self):
        settings = release.forgejo_settings(
            {"FORGEJO_URL": "https://env.invalid"}, {"FORGEJO_URL": "https://file.invalid"}, "h.invalid"
        )
        self.assertEqual((settings.base_url, settings.url_source), ("https://env.invalid", "FORGEJO_URL from environment"))
        settings = release.forgejo_settings({}, {"FORGEJO_URL": "https://file.invalid"}, "h.invalid")
        self.assertEqual(settings.base_url, "https://file.invalid")
        settings = release.forgejo_settings({}, {}, "forge.example.invalid")
        self.assertEqual((settings.base_url, settings.url_source), ("https://forge.example.invalid", "host of origin"))

    def test_sources_never_contain_the_token(self):
        settings = release.forgejo_settings({"FORGEJO_TOKEN": FAKE_TOKEN}, {}, "h.invalid")
        self.assertNotIn(FAKE_TOKEN, settings.token_source + settings.url_source)


class RemoteUrlTest(unittest.TestCase):
    def test_ssh_with_port(self):
        self.assertEqual(
            release.parse_remote_url("ssh://git@forge.example.invalid:2222/owner/hangar-note.git"),
            release.Remote("forge.example.invalid", 2222, "owner", "hangar-note"),
        )

    def test_scp_form(self):
        self.assertEqual(
            release.parse_remote_url("git@github.com:owner/hangar-note.git"),
            release.Remote("github.com", None, "owner", "hangar-note"),
        )

    def test_https(self):
        self.assertEqual(
            release.parse_remote_url("https://Forge.Example.invalid/owner/repo/"),
            release.Remote("forge.example.invalid", None, "owner", "repo"),
        )

    def test_credentials_are_refused_without_echo(self):
        with self.assertRaises(ValueError) as caught:
            release.parse_remote_url("https://user:%s@forge.example.invalid/o/r.git" % FAKE_TOKEN)
        self.assertNotIn(FAKE_TOKEN, str(caught.exception))

    def test_bad_forms(self):
        for url in ("origin", "", "https://h.invalid/only-owner", "ssh://h.invalid/a/b/c", "file:///c/repo", "C:\\repo"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                release.parse_remote_url(url)


class PushCommandTest(unittest.TestCase):
    URL = "ssh://git@forge.example.invalid:2222/owner/repo.git"

    def test_never_a_remote_name(self):
        for destination in ("origin", "github", "--mirror", "-o"):
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                release.push_command(destination, COMMIT, "v0.1.0")

    def test_main_and_tag_atomically_to_a_url(self):
        self.assertEqual(
            release.push_command(self.URL, COMMIT, "v0.1.0"),
            ["push", "--atomic", "--porcelain", self.URL, COMMIT + ":refs/heads/main", "refs/tags/v0.1.0:refs/tags/v0.1.0"],
        )

    def test_needs_a_full_commit_and_a_version_tag(self):
        with self.assertRaises(ValueError):
            release.push_command(self.URL, "HEAD", "v0.1.0")
        with self.assertRaises(ValueError):
            release.push_command(self.URL, COMMIT, "main")


class PushConfigTest(unittest.TestCase):
    URL = "ssh://git@forge.example.invalid:2222/owner/repo.git"
    HOST = "forge.example.invalid"

    def test_remote_named_like_a_url(self):
        output = "remote.ssh://git@forge.example.invalid:2222/owner/repo.git.url\nssh://other.invalid/x/y\0"
        problems = release.redirect_config_problems(output, self.HOST, self.URL)
        self.assertEqual(len(problems), 1)
        self.assertNotIn("other.invalid", problems[0])

    def test_insteadof_rules_for_the_host(self):
        for output in (
            "url.ssh://evil.invalid/.pushinsteadof\nssh://git@forge.example.invalid\0",
            "url.ssh://git@forge.example.invalid:2222/.insteadof\nforge:\0",
            "url.https://elsewhere.invalid/.insteadof\nssh://git@\0",
        ):
            with self.subTest(output=output):
                self.assertEqual(len(release.redirect_config_problems(output, self.HOST, self.URL)), 1)

    def test_unrelated_settings_pass(self):
        output = (
            "remote.origin.url\nssh://git@forge.example.invalid:2222/owner/repo.git\0"
            "remote.github.pushurl\ngit@github.com:owner/repo.git\0"
            "url.https://github.com/.insteadof\ngh:\0"
        )
        self.assertEqual(release.redirect_config_problems(output, self.HOST, self.URL), [])
        self.assertEqual(len(release.redirect_config_problems(output, "github.com", "git@github.com:owner/repo.git")), 1)

    def test_credential_programs_from_the_repository_are_refused(self):
        root = release.ROOT
        output = (
            "file:C:/Program Files/Git/etc/gitconfig\0credential.helper\nmanager\0"
            "file:.git/config\0core.sshcommand\nssh -i key\0"
            "file:%s\0core.askpass\nx\0"
            "command line:\0credential.helper\nx\0"
        ) % (root / ".git" / "extra.config").as_posix()
        problems = release.repository_config_problems(output, root)
        self.assertEqual(len(problems), 2)
        self.assertTrue(problems[0].startswith("core.sshcommand"))
        self.assertTrue(all("ssh -i key" not in problem for problem in problems))

    def test_local_config_counts_also_from_files_outside_the_repository(self):
        # `git config --local --includes`: an included file outside the repository and the main
        # repository's config of a linked worktree lie outside ROOT and still come from the repo.
        output = (
            "file:D:/elsewhere/included.cfg\0core.sshcommand\nssh -i key\0"
            "file:D:/main-repo/.git/config\0credential.helper\nx\0"
            "command line:\0credential.helper\nx\0"
        )
        self.assertEqual(release.repository_config_problems(output, release.ROOT), [])
        problems = release.repository_config_problems(output, release.ROOT, local=True)
        self.assertEqual(
            problems,
            ["core.sshcommand is set in D:/elsewhere/included.cfg", "credential.helper is set in D:/main-repo/.git/config"],
        )

    def test_check_push_config_asks_the_local_config_with_includes(self):
        calls = []

        def fake_git_run(*args, allowed=(0,), network=False):
            calls.append(args)
            if "--local" in args:
                return mock.Mock(returncode=0, stdout="file:D:/elsewhere/x.cfg\0core.askpass\nx\0")
            return mock.Mock(returncode=1, stdout="")

        with mock.patch.object(release, "git_run", fake_git_run):
            message = quiet_fail(self, release.check_push_config, self.HOST, self.URL)
        self.assertIn("core.askpass", message)
        self.assertIn(("config", "--local", "--includes", "--show-origin", "-z", "--get-regexp", release.CREDENTIAL_KEYS), calls)

    def test_failed_push_names_the_way_back(self):
        failed = mock.Mock(returncode=1, stdout="", stderr="rejected")
        with mock.patch.object(release, "git_run", return_value=failed), contextlib.redirect_stdout(io.StringIO()):
            message = quiet_fail(self, release.push, self.URL, COMMIT, "v0.1.0", "Forgejo", " hint: git tag -d v0.1.0")
        self.assertIn("rejected", message)
        self.assertIn("git tag -d v0.1.0", message)

    def test_github_hint_keeps_the_forgejo_flags(self):
        self.assertEqual(
            release.github_publish_hint("0.1.0", False, True),
            "py -3 tools/release.py --publish github --release 0.1.0 --prerelease --allow-unsigned",
        )
        self.assertEqual(
            release.github_publish_hint("0.2.0", True, False), "py -3 tools/release.py --publish github --release 0.2.0"
        )

    def test_push_output_must_name_the_expected_url(self):
        done = "\t%s:refs/heads/main\t[new branch]\nDone\n" % COMMIT
        self.assertIsNone(release.porcelain_destination_problem("To %s\n%s" % (self.URL, done), self.URL))
        anonymous = "To ssh://forge.example.invalid:2222/owner/repo.git\n" + done
        self.assertIsNone(release.porcelain_destination_problem(anonymous, self.URL))
        self.assertIsNone(
            release.porcelain_destination_problem("To github.com:o/r.git\n" + done, "git@github.com:o/r.git")
        )
        self.assertIn("another URL", release.porcelain_destination_problem("To ssh://evil.invalid/o/r\n" + done, self.URL))
        self.assertIn("no destination", release.porcelain_destination_problem(done, self.URL))


class FakeResponse(io.BytesIO):
    def __init__(self, status, payload):
        super().__init__(payload)
        self.status = status


class FakeOpener:
    """Records every request and answers from a list of (status, JSON) pairs."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        status, body = self.answers.pop(0)
        payload = json.dumps(body).encode("utf-8")
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "error", {}, io.BytesIO(payload))
        return FakeResponse(status, payload)


def client(opener):
    return release.ForgejoClient("https://forge.example.invalid/", FAKE_TOKEN, "owner", "repo", opener)


class ForgejoClientTest(unittest.TestCase):
    def test_https_only(self):
        for url in ("http://forge.example.invalid", "forge.example.invalid", "https://u:p@forge.example.invalid", ""):
            with self.subTest(url=url), self.assertRaises(release.ForgejoError):
                release.ForgejoClient(url, FAKE_TOKEN, "o", "r", FakeOpener())
        self.assertEqual(release.api_base("https://forge.example.invalid/sub/"), "https://forge.example.invalid/sub/api/v1")

    def test_bad_token_is_refused_without_echo(self):
        with self.assertRaises(release.ForgejoError) as caught:
            release.ForgejoClient("https://forge.example.invalid", "fake token\n", "o", "r", FakeOpener())
        self.assertNotIn("fake token", str(caught.exception))

    def test_create_release_body_and_headers(self):
        opener = FakeOpener((201, {"id": 7}))
        body = release.release_request_body("v0.1.0", "Hangar Note 0.1.0-14", "- Notes", True, COMMIT)
        self.assertEqual(client(opener).create_release(body), {"id": 7})
        request = opener.requests[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.full_url, "https://forge.example.invalid/api/v1/repos/owner/repo/releases")
        self.assertEqual(request.get_header("Authorization"), "token " + FAKE_TOKEN)
        # Unredirected: urllib never copies it to a redirect target.
        self.assertIn("Authorization", request.unredirected_hdrs)
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(
            json.loads(request.data),
            {
                "tag_name": "v0.1.0",
                "target_commitish": COMMIT,
                "name": "Hangar Note 0.1.0-14",
                "body": "- Notes",
                "draft": True,
                "prerelease": True,
            },
        )

    def test_missing_release_is_none(self):
        opener = FakeOpener((404, {"message": "not found"}))
        self.assertIsNone(client(opener).release_by_tag("v0.1.0"))
        self.assertTrue(opener.requests[0].full_url.endswith("/repos/owner/repo/releases/tags/v0.1.0"))

    def test_errors_never_contain_the_token(self):
        opener = FakeOpener((500, {"message": "bad token %s" % FAKE_TOKEN}))
        with self.assertRaises(release.ForgejoError) as caught:
            client(opener).repository()
        self.assertIn("500", str(caught.exception))
        self.assertNotIn(FAKE_TOKEN, str(caught.exception))

    def test_network_errors_never_contain_the_token(self):
        class Broken:
            def open(self, request, timeout=None):
                raise urllib.error.URLError("refused " + FAKE_TOKEN)

        with self.assertRaises(release.ForgejoError) as caught:
            client(Broken()).repository()
        self.assertNotIn(FAKE_TOKEN, str(caught.exception))

    def test_redirects_are_refused(self):
        handler = release._NoRedirect()
        request = urllib.request.Request("https://forge.example.invalid/api/v1/x")
        self.assertIsNone(handler.redirect_request(request, None, 302, "Found", {}, "https://other.invalid/"))
        opener = FakeOpener((302, {}))
        with self.assertRaises(release.ForgejoError):
            client(opener).repository()

    def test_upload_asset_multipart(self):
        opener = FakeOpener((201, {"id": 1, "size": len(b"installer bytes")}))
        client(opener).upload_asset(7, "Hangar-Note_0.1.0-14_x64-setup.exe", b"installer bytes")
        request = opener.requests[0]
        self.assertTrue(
            request.full_url.endswith("/repos/owner/repo/releases/7/assets?name=Hangar-Note_0.1.0-14_x64-setup.exe")
        )
        content_type = request.get_header("Content-type")
        self.assertTrue(content_type.startswith("multipart/form-data; boundary="))
        boundary = content_type.split("boundary=")[1].encode()
        self.assertTrue(request.data.startswith(b"--" + boundary + b"\r\n"))
        self.assertIn(b'name="attachment"; filename="Hangar-Note_0.1.0-14_x64-setup.exe"', request.data)
        self.assertIn(b"\r\n\r\ninstaller bytes\r\n--" + boundary + b"--\r\n", request.data)

    def test_upload_with_wrong_size_fails(self):
        with self.assertRaises(release.ForgejoError):
            client(FakeOpener((201, {"size": 2}))).upload_asset(7, "SHA256SUMS.txt", b"abc")

    def test_protocol_errors_are_forgejo_errors(self):
        class Broken:
            def open(self, request, timeout=None):
                raise release.http.client.RemoteDisconnected("closed " + FAKE_TOKEN)

        with self.assertRaises(release.ForgejoError) as caught:
            client(Broken()).repository()
        self.assertNotIn(FAKE_TOKEN, str(caught.exception))

    def test_push_permission(self):
        self.assertIsNone(release.repository_push_problem({"permissions": {"push": True}}))
        for answer in ({"permissions": {"push": False}}, {"permissions": {}}, {}, None):
            with self.subTest(answer=answer):
                self.assertIn("push permission", release.repository_push_problem(answer))

    def test_publish_clears_the_draft(self):
        opener = FakeOpener((200, {"id": 7, "draft": False}))
        client(opener).publish_release(7)
        self.assertEqual(opener.requests[0].get_method(), "PATCH")
        self.assertEqual(json.loads(opener.requests[0].data), {"draft": False})

    def test_multipart_refuses_paths(self):
        with self.assertRaises(ValueError):
            release.multipart_body("attachment", "../x.exe", b"")


class VersionRulesTest(unittest.TestCase):
    def setUp(self):
        self.empty = fresh_folder("release-empty")

    def test_build_number_without_base(self):
        self.assertEqual(release.build_number_from({"version": "0.1.0"}, 14), 14)
        self.assertEqual(release.build_number_from({"buildNumberBase": 84}, 14), 98)

    def test_display_and_names(self):
        self.assertEqual(release.display("0.1.0+14"), "0.1.0-14")
        self.assertEqual(release.tag_name("0.1.0"), "v0.1.0")
        self.assertEqual(release.installer_name("0.1.0+14"), "Hangar-Note_0.1.0-14_x64-setup.exe")
        self.assertEqual(release.parse_version("0.1.0+14"), ((0, 1, 0), 14))
        self.assertEqual(release.parse_version("0.1.0"), ((0, 1, 0), None))
        self.assertIsNone(release.parse_version("0.1.0-14"))

    def test_first_release(self):
        entries = [{"version": "0.1.0", "date": None, "items": []}]
        self.assertIsNone(release.release_problem("0.1.0", "0.1.0", entries, self.empty))

    def test_release_must_be_the_top_changelog_entry(self):
        entries = [{"version": "0.2.0", "date": None}, {"version": "0.1.0", "date": "2026-11-27"}]
        self.assertIn("highest", release.release_problem("0.1.0", "0.2.0", entries, self.empty))
        self.assertIn("X.Y.Z", release.release_problem("0.2.0+3", "0.2.0", entries, self.empty))

    def test_release_not_lower_than_files_nor_released(self):
        entries = [{"version": "0.1.0", "date": "2026-11-27"}]
        self.assertIn("higher than the released", release.release_problem("0.1.0", "0.1.0+14", entries, self.empty))
        entries = [{"version": "0.1.0", "date": None}]
        self.assertIn("lower", release.release_problem("0.1.0", "0.2.0", entries, self.empty))

    def test_existing_release_folder_blocks_a_rebuild(self):
        folder = fresh_folder("release-existing")
        (folder / "0.1.0-14").mkdir()
        entries = [{"version": "0.1.0", "date": None}]
        self.assertIn("exists already", release.release_problem("0.1.0", "0.1.0", entries, folder))

    def test_next(self):
        released = [{"version": "0.1.0", "date": "2026-11-27"}]
        self.assertIsNone(release.next_problem("0.2.0", "0.1.0+14", released, self.empty))
        self.assertIn("not released", release.next_problem("0.2.0", "0.1.0", [{"version": "0.1.0", "date": None}], self.empty))
        self.assertIn("higher", release.next_problem("0.1.0", "0.1.0+14", released, self.empty))
        self.assertEqual(release.with_next_entry(released, "0.2.0")[0], {"version": "0.2.0", "date": None, "items": []})
        self.assertEqual(release.suggest_next("0.1.3"), "0.2.0")

    def test_release_commit(self):
        files = ["package.json", "src/changelog.json", "src-tauri/Cargo.lock"]
        self.assertIsNone(release.release_commit_problem(15, 14, files))
        self.assertIn("commit 15", release.release_commit_problem(16, 14, files))
        self.assertIn("src/main.tsx", release.release_commit_problem(15, 14, files + ["src/main.tsx"]))

    def test_version_replacements_keep_the_format(self):
        package = '{\n  "name": "hangar-note",\n  "version": "0.1.0",\n  "list": [1, 2]\n}\n'
        self.assertEqual(
            release.replace_json_version(package, "0.1.0+14"),
            '{\n  "name": "hangar-note",\n  "version": "0.1.0+14",\n  "list": [1, 2]\n}\n',
        )
        self.assertIsNone(release.replace_json_version('{\n"version": "0.1.0"\n}', "0.2.0"))
        cargo = '[package]\nname = "hangar-note"\nversion = "0.1.0"\n\n[dependencies]\nx = { version = "1" }\n'
        self.assertIn('version = "0.1.0+14"', release.replace_cargo_version(cargo, "0.1.0+14"))
        self.assertIn('version = "1"', release.replace_cargo_version(cargo, "0.1.0+14"))
        lock = '[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "hangar-note"\nversion = "0.1.0"\n'
        updated = release.replace_lock_version(lock, "0.1.0+14")
        self.assertIn('name = "other"\nversion = "1.0.0"', updated)
        self.assertIn('name = "hangar-note"\nversion = "0.1.0+14"', updated)

    def test_the_real_files_carry_a_replaceable_version(self):
        for path, replace in (
            (release.TAURI_CONF, release.replace_json_version),
            (release.PACKAGE_JSON, release.replace_json_version),
            (release.CARGO_TOML, release.replace_cargo_version),
            (release.CARGO_LOCK, release.replace_lock_version),
        ):
            with self.subTest(path=path.name):
                self.assertIsNotNone(replace(path.read_text(encoding="utf-8"), "9.9.9+1"))

    def test_notes_are_the_english_items(self):
        entry = {"version": "0.1.0", "items": [{"en": " One. ", "de": "Eins."}, {"en": "Two."}]}
        self.assertEqual(release.changelog_notes(entry), "- One.\n- Two.")
        self.assertIsNone(release.changelog_notes({"version": "0.2.0", "items": []}))


class ChecksumTest(unittest.TestCase):
    def setUp(self):
        self.root = fresh_folder("checksums")
        self.folder = self.root / "0.1.0-14"
        self.folder.mkdir()
        self.name = "Hangar-Note_0.1.0-14_x64-setup.exe"
        (self.folder / self.name).write_bytes(b"abc")

    def read(self):
        return release.read_release_files(self.folder, self.name, self.root)

    def test_sha256sum_format_with_lf(self):
        release.write_checksums(self.folder, [self.name])
        line = b"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  " + self.name.encode() + b"\n"
        self.assertEqual((self.folder / "SHA256SUMS.txt").read_bytes(), line)
        assets, problems = self.read()
        self.assertEqual(problems, [])
        self.assertEqual([(asset.name, asset.data) for asset in assets], [(self.name, b"abc"), ("SHA256SUMS.txt", line)])

    def test_changed_file_is_detected(self):
        release.write_checksums(self.folder, [self.name])
        (self.folder / self.name).write_bytes(b"abd")
        _, problems = self.read()
        self.assertTrue(any("does not match" in problem for problem in problems))

    def test_listed_names_must_be_exactly_the_installer(self):
        (self.folder / "extra.txt").write_bytes(b"x")
        release.write_checksums(self.folder, [self.name, "extra.txt"])
        _, problems = self.read()
        self.assertTrue(any("exactly" in problem for problem in problems))
        (self.folder / "SHA256SUMS.txt").write_bytes(("0" * 64 + "  ../evil.txt\n").encode())
        _, problems = self.read()
        self.assertTrue(any("unreadable line" in problem for problem in problems))

    def test_folder_must_lie_inside_release(self):
        release.write_checksums(self.folder, [self.name])
        other = fresh_folder("checksums-other")
        _, problems = release.read_release_files(self.folder, self.name, other)
        self.assertTrue(any("not inside" in problem for problem in problems))

    def test_links_and_reparse_points_are_refused(self):
        regular = release.os.lstat(self.folder / self.name)
        self.assertIsNone(release.plain_stat_problem(regular))
        self.assertIn("regular", release.plain_stat_problem(release.os.lstat(self.folder)))
        self.assertIsNone(release.plain_stat_problem(release.os.lstat(self.folder), directory=True))
        fake = mock.Mock(st_mode=regular.st_mode, st_file_attributes=release.FILE_ATTRIBUTE_REPARSE_POINT)
        self.assertIn("reparse", release.plain_stat_problem(fake))

    def test_a_symlinked_installer_is_refused(self):
        outside = fresh_folder("checksums-outside") / "real.exe"
        outside.write_bytes(b"abc")
        link = self.folder / self.name
        link.unlink()
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("creating symbolic links needs a privilege here")
        release.write_checksums(self.folder, [self.name])
        _, problems = self.read()
        self.assertTrue(any("link" in problem for problem in problems))

    def test_build_commit(self):
        self.assertIsNone(release.read_build_commit(self.folder))
        (self.folder / "BUILD_COMMIT").write_bytes((COMMIT + "\n").encode())
        self.assertEqual(release.read_build_commit(self.folder), COMMIT)
        rel = release.Release("0.1.0", "0.1.0+14", self.folder)
        self.assertIsNone(release.build_commit_problem(rel, COMMIT))
        self.assertIn("does not follow", release.build_commit_problem(rel, "f" * 40))
        (self.folder / "BUILD_COMMIT").write_bytes(b"HEAD\n")
        self.assertIn("missing", release.build_commit_problem(rel, COMMIT))

    def test_recheck_catches_a_swap(self):
        release.write_checksums(self.folder, [self.name])
        assets, _ = self.read()
        rel = release.Release("0.1.0", "0.1.0+14", self.folder)
        release.recheck(rel, assets, "now")
        (self.folder / self.name).write_bytes(b"abd")
        self.assertIn("changed now", quiet_fail(self, release.recheck, rel, assets, "now"))


class GithubCommandsTest(unittest.TestCase):
    FILES = [Path("release/0.1.0-14/Hangar-Note_0.1.0-14_x64-setup.exe"), Path("release/0.1.0-14/SHA256SUMS.txt")]

    def commands(self, prerelease=False, draft=False):
        return release.github_release_commands(
            "C:/gh/gh.exe", "v0.1.0", "owner/hangar-note", self.FILES, "Hangar Note 0.1.0-14",
            Path("release/0.1.0-14/release-notes.md"), prerelease, draft,
        )

    def test_draft_first_then_published(self):
        create, edit = self.commands()
        self.assertEqual(create[:4], ["C:/gh/gh.exe", "release", "create", "v0.1.0"])
        self.assertEqual(create[4:6], [str(path) for path in self.FILES])
        for flag in ("--verify-tag", "--draft"):
            self.assertIn(flag, create)
        self.assertEqual(create[create.index("--repo") + 1], "owner/hangar-note")
        self.assertEqual(create[create.index("--title") + 1], "Hangar Note 0.1.0-14")
        self.assertEqual(edit, ["C:/gh/gh.exe", "release", "edit", "v0.1.0", "--repo", "owner/hangar-note", "--draft=false", "--latest"])
        self.assertTrue(all(isinstance(arg, str) for argv in (create, edit) for arg in argv))

    def test_prerelease_is_never_latest(self):
        create, edit = self.commands(prerelease=True)
        self.assertIn("--prerelease", create)
        self.assertNotIn("--latest", edit)

    def test_draft_stays_a_draft(self):
        self.assertEqual(len(self.commands(draft=True)), 1)


class BuildTest(unittest.TestCase):
    def test_signing_config_lives_under_release_and_the_build_sees_no_secret(self):
        folder = fresh_folder("build-release")
        seen = {}

        def fake_run(command, cwd, env, check):
            config = Path(command[command.index("--config") + 1])
            seen.update(config=config, data=json.loads(config.read_text(encoding="utf-8")), env=env)
            return mock.Mock(returncode=0)

        signing = {"bundle": {"windows": {"certificateThumbprint": THUMB.upper()}}}
        environ = {"PATH": "p", "HANGAR_NOTE_CERT_THUMBPRINT": THUMB, "FORGEJO_TOKEN": FAKE_TOKEN}
        with mock.patch.object(release, "tauri_command", return_value=["node", "tauri.js", "build"]), mock.patch.object(
            release.subprocess, "run", fake_run
        ), mock.patch.object(release, "RELEASE_DIR", folder), mock.patch.dict(release.os.environ, environ, clear=True):
            release.build(signing)
        self.assertTrue(release.is_inside(seen["config"], folder))
        self.assertFalse(seen["config"].exists())
        self.assertEqual(seen["data"], signing)
        self.assertEqual(seen["env"], {"PATH": "p"})


class BuildInputsTest(unittest.TestCase):
    def test_hidden_build_inputs_are_found(self):
        root = fresh_folder("inputs")
        (root / "src-tauri").mkdir()
        (root / "src-tauri" / "tauri.conf.json").write_text("{}")
        (root / "src-tauri" / "tauri.windows.conf.json").write_text("{}")
        (root / ".cargo").mkdir()
        (root / ".cargo" / "config.toml").write_text("")
        (root / ".npmrc").write_text("")
        found = {path.relative_to(root).as_posix() for path in release.build_input_problems(root, ancestors=[])}
        self.assertEqual(found, {"src-tauri/tauri.windows.conf.json", ".cargo/config.toml", ".npmrc"})

    def test_clean_root_has_none(self):
        root = fresh_folder("inputs-clean")
        (root / "src-tauri").mkdir()
        self.assertEqual(release.build_input_problems(root, ancestors=[]), [])

    def test_filters_are_switched_off(self):
        self.assertEqual(
            release.filter_overrides("filter.lfs.clean\ngit-lfs clean\0"),
            ["-c", "filter.lfs.clean=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false"],
        )
        self.assertIsNone(release.filter_overrides("filter.a=b.clean\nx\0"))


class ProgramTest(unittest.TestCase):
    def test_programs_in_the_repository_never_count(self):
        root = fresh_folder("programs")
        inside = root / "repo" / "bin"
        outside = root / "system"
        inside.mkdir(parents=True)
        outside.mkdir()
        for folder in (inside, outside):
            (folder / "git.exe").write_bytes(b"")
            (folder / "git.cmd").write_bytes(b"")
        search = "relative;%s;%s" % (inside, outside)
        with mock.patch.object(release.os, "pathsep", ";"):
            found = release.find_program("git", search, [root / "repo"], True)
        self.assertEqual(Path(found), outside.resolve() / "git.exe")

    def test_tauri_cli_matches_the_lock_file(self):
        lock = "importers:\n  .:\n    devDependencies:\n      '@tauri-apps/cli':\n        specifier: ^2.12.4\n        version: 2.12.6\n"
        self.assertEqual(release.locked_cli_version(lock), "2.12.6")
        self.assertIsNone(release.cli_version_problem('{"version": "2.12.6"}', lock))
        self.assertIn("pnpm install", release.cli_version_problem('{"version": "2.12.5"}', lock))


if __name__ == "__main__":
    unittest.main()
