"""Builds a Hangar Note release for Windows and publishes it, first on Forgejo, later on GitHub.

Usage:
  py -3 tools/release.py --version 0.1.0 --dry-run       # show what a release would do
  py -3 tools/release.py --version 0.1.0                 # date the changelog, set X.Y.Z+B, build
  py -3 tools/release.py --version 0.1.0 --allow-unsigned   # ... without Authenticode (warns)
  py -3 tools/release.py --publish forgejo --prerelease  # upload the built state to Forgejo
  py -3 tools/release.py --publish github --release 0.1.0   # later: the same files to GitHub
  py -3 tools/release.py --next 0.2.0                    # after the release: the upcoming version

The three steps are separate on purpose. --version builds and changes files in the repository,
--publish only uploads what release/<X.Y.Z-B>/ holds, and the script never commits: it prints the
files to commit after --version and --next.

Version scheme (docs/wiki/pages/decisions/0003-version-scheme.md): Major.Minor.Revision-Build.
The build number B is `git rev-list --count HEAD` of the built state; Hangar Note has no base, so
a missing buildNumberBase in package.json counts as 0. Internally the files carry X.Y.Z+B (Tauri
turns it into the Windows file version X.Y.Z.B); shown and in file names it is X.Y.Z-B.

Rule "the code always carries the upcoming version": tauri.conf.json, package.json, Cargo.toml and
Cargo.lock name the version that ships next, and it is the highest entry of src/changelog.json,
still undated there. --version X.Y.Z must be that entry, must not be lower than the files and must
be higher than the last release (the highest dated changelog entry or a folder under release/).
--next X.Y.Z moves the files to the following version and adds it to the changelog, empty and
undated; it is refused while the current top entry is not released.

--version X.Y.Z (Windows only):
  1. Checks the version rules, a clean working tree (untracked files included, git's fsmonitor,
     hooks and filters switched off) and build inputs Git does not see: Tauri config overrides
     next to tauri.conf.json, Cargo configs and rust-toolchain files in src-tauri, the repository
     and every folder above it, and an .npmrc in the repository.
  2. Dates the changelog entry and writes X.Y.Z+B into the four version files.
  3. Runs `tauri build --bundles nsis` through node.exe and the CLI's tauri.js directly, never
     through the pnpm.cmd shim, so no argument passes cmd.exe. No build process sees a variable
     ending in _TOKEN, a Tauri signing key variable or the HANGAR_NOTE_* signing settings; the
     Authenticode setting reaches Tauri as a --config file under release/, removed afterwards.
  4. With Authenticode set up (see below), checks the signature of the installer and the program.
  5. Puts the files to upload under release/<X.Y.Z-B>/:
       Hangar-Note_<X.Y.Z-B>_x64-setup.exe   the installer
       SHA256SUMS.txt                        its SHA-256 (sha256sum format, LF)
     and BUILD_COMMIT, the id of the built commit, which is not uploaded.

--publish forgejo (the default target, always first):
  Needs the release commit: HEAD on main, clean, whose parent is BUILD_COMMIT and which changes
  nothing but the version files and the changelog. SHA256SUMS.txt must list exactly the installer,
  every file must be a regular file (no link or reparse point) inside release/, and each file is
  read once: the bytes whose SHA-256 was checked are the bytes uploaded. Then the script checks
  the installer's Authenticode signature and
  1. derives owner and repository from the fetch URL of the remote origin, whose host must be
     the host of the Forgejo URL (the project's own Forgejo instance),
  2. refuses when the Git config could send the push elsewhere (a remote named like a URL, an
     insteadOf or pushInsteadOf rule for the host) or when the repository's own config (its
     .git/config and every file included from there) sets core.sshCommand, core.askPass or
     credential.*,
  3. refuses when tag vX.Y.Z exists locally, on the server or as a release there, or when the
     token has no push permission for the repository,
  4. creates the tag, pushes main and the tag atomically to that fetch URL (never `git push
     origin`: origin also pushes to GitHub) and checks that git reports exactly that URL,
  5. creates the release through the Forgejo API as a draft, uploads the installer and
     SHA256SUMS.txt, and only then publishes it (unless --draft). --prerelease marks it as such.
  FORGEJO_URL is the API root (environment, then the git-ignored .env in the repository root),
  else https://<host of origin>; https only. FORGEJO_TOKEN is the token (environment, then .env).
  .env is read as plain KEY=VALUE text, nothing in it runs. The token goes only into the
  Authorization header of the API requests; it is never printed, logged, written to a file or
  passed to a child process, and redirects are refused so it never reaches another host.

--publish github (later, after the owner's go):
  Uploads the same files of release/<X.Y.Z-B>/ without building again: checks them as above,
  needs the local tag vX.Y.Z from the Forgejo step (its parent must be BUILD_COMMIT), pushes that
  commit as main and the tag to the single push URL of the remote github, then runs
  `gh release create` as a draft with the files and publishes it with `gh release edit`. The
  hashes are checked again right before and after gh reads the files. --release X.Y.Z names the
  release once --next has moved the files on.

Unsigned builds: --version and --publish refuse an installer without a valid, timestamped
Authenticode signature unless --allow-unsigned is given, which prints a warning and adds a line to
the release notes asking users to check the installer against SHA256SUMS.txt.

Authenticode code signing (optional through the environment):
  HANGAR_NOTE_CERT_THUMBPRINT   SHA-1 thumbprint of a certificate in the Windows certificate store;
                                Tauri then signs with signtool (SHA-256, timestamped).
  HANGAR_NOTE_TIMESTAMP_URL     timestamp server for it (default http://time.certum.pl).
  HANGAR_NOTE_TIMESTAMP_TSP     1 (default) = RFC 3161 (signtool /tr), 0 = legacy Authenticode (/t).
  HANGAR_NOTE_SIGN_COMMAND      instead, a signing command as a JSON argv with "%1" for the file.
  The setting goes to `tauri build` as a --config file; tauri.conf.json stays unchanged.

git, node, gh and PowerShell are taken only as absolute programs from PATH (on Windows only `.exe`),
never from the repository or the working folder. No dependencies beyond Python 3 and the project
toolchain. Never prints tokens, thumbprints or signing commands.
"""
import argparse
import collections
import datetime
import hashlib
import http.client
import json
import os
import re
import secrets
import shutil
import ssl
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAURI_CONF = ROOT / "src-tauri" / "tauri.conf.json"
CARGO_TOML = ROOT / "src-tauri" / "Cargo.toml"
CARGO_LOCK = ROOT / "src-tauri" / "Cargo.lock"
PACKAGE_JSON = ROOT / "package.json"
CHANGELOG_JSON = ROOT / "src" / "changelog.json"
PNPM_LOCK = ROOT / "pnpm-lock.yaml"
# The files a release commit may change: the version in four places and the changelog date.
VERSION_FILES = frozenset(
    {
        "package.json",
        "src-tauri/tauri.conf.json",
        "src-tauri/Cargo.toml",
        "src-tauri/Cargo.lock",
        "src/changelog.json",
    }
)
CRATE_NAME = "hangar-note"
PRODUCT = "Hangar Note"
BUNDLE_DIR = ROOT / "src-tauri" / "target" / "release" / "bundle" / "nsis"
MAIN_EXE = ROOT / "src-tauri" / "target" / "release" / (CRATE_NAME + ".exe")
RELEASE_DIR = ROOT / "release"
CHECKSUMS_NAME = "SHA256SUMS.txt"
NOTES_NAME = "release-notes.md"
# The Tauri CLI's own entry point; run with node.exe, not through a .cmd shim.
TAURI_JS = ROOT / "node_modules" / "@tauri-apps" / "cli" / "tauri.js"
TAURI_CLI_PACKAGE = TAURI_JS.with_name("package.json")
BASE_VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
FULL_VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$")
DEFAULT_TIMESTAMP_URL = "http://time.certum.pl"
THUMBPRINT = re.compile(r"^[0-9A-F]{40}$")
TIMESTAMP_URL = re.compile(r"^https?://\S+$")
# Owner and repository names as Forgejo and GitHub allow them; also keeps them safe in URLs.
REPO_PART = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
ASSET_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
CHECKSUM_LINE = re.compile(r"^([0-9a-f]{64})  (.+)$")
API_TIMEOUT = 60
GITHUB_HOST = "github.com"
# Variables no child process needs except the one that uses them: the API token, gh's tokens and
# Tauri's updater key. Build scripts and dependencies run third-party code.
# Any variable ending in _TOKEN (the Forgejo token, gh's tokens and whatever else the shell holds)
# counts as a secret.
SECRET_SUFFIX = "_TOKEN"
SECRET_PREFIX = "TAURI_SIGNING_PRIVATE_KEY"
# The Authenticode settings reach Tauri as a --config file; no child process needs the variables.
SIGNING_VARIABLES = frozenset(
    {
        "HANGAR_NOTE_CERT_THUMBPRINT",
        "HANGAR_NOTE_SIGN_COMMAND",
        "HANGAR_NOTE_TIMESTAMP_URL",
        "HANGAR_NOTE_TIMESTAMP_TSP",
    }
)
DOTENV = ROOT / ".env"
BUILD_COMMIT_NAME = "BUILD_COMMIT"
COMMIT_ID = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
# git variables a push over SSH may need; every other GIT_* variable could point git elsewhere.
GIT_SSH_VARIABLES = frozenset({"GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_ASKPASS"})


def fail(message):
    print("ERROR: " + message, file=sys.stderr)
    sys.exit(1)


def warn_unsigned(what):
    print()
    print("WARNING: %s is NOT code-signed (--allow-unsigned)." % what)
    print("  Windows SmartScreen warns on first start and users cannot see the publisher.")
    print("  The only integrity check users have is SHA256SUMS.txt.")
    print()


# ---------------------------------------------------------------------------------------------
# Authenticode


class SigningError(ValueError):
    """Invalid signing setting. The message never names the value, only the variable."""


def windows_signing_config(env):
    """The --config override for `tauri build` from the environment, or None when nothing is set.

    Pure function: it reads only the mapping it is given.
    """
    thumbprint = env.get("HANGAR_NOTE_CERT_THUMBPRINT", "").strip()
    command = env.get("HANGAR_NOTE_SIGN_COMMAND", "").strip()
    if thumbprint and command:
        raise SigningError(
            "HANGAR_NOTE_CERT_THUMBPRINT and HANGAR_NOTE_SIGN_COMMAND exclude each other; set only one."
        )
    if command:
        return {"bundle": {"windows": {"signCommand": _sign_command(command)}}}
    if not thumbprint:
        return None

    # Thumbprints copied from the certificate viewer often contain spaces, colons or an invisible
    # direction mark (U+200E) at the start; none of that is part of the value.
    thumbprint = re.sub(r"[\s:\u200e\u200f]", "", thumbprint).upper()
    if not THUMBPRINT.match(thumbprint):
        raise SigningError("HANGAR_NOTE_CERT_THUMBPRINT is not a SHA-1 thumbprint (40 hex characters).")

    # Without a timestamp the signature becomes invalid once the certificate expires.
    timestamp_url = env.get("HANGAR_NOTE_TIMESTAMP_URL", "").strip() or DEFAULT_TIMESTAMP_URL
    if not TIMESTAMP_URL.match(timestamp_url):
        raise SigningError(
            "HANGAR_NOTE_TIMESTAMP_URL must start with http:// or https:// and must not contain spaces."
        )
    tsp = env.get("HANGAR_NOTE_TIMESTAMP_TSP", "").strip() or "1"
    if tsp not in ("0", "1"):
        raise SigningError("HANGAR_NOTE_TIMESTAMP_TSP expects 0 or 1.")
    return {
        "bundle": {
            "windows": {
                "certificateThumbprint": thumbprint,
                "digestAlgorithm": "sha256",
                "timestampUrl": timestamp_url,
                # RFC 3161 (signtool /tr /td) yields SHA-256 timestamps; the legacy /t only SHA-1.
                "tsp": tsp == "1",
            }
        }
    }


def _sign_command(raw):
    """HANGAR_NOTE_SIGN_COMMAND as argv. Tauri's string form splits on spaces and breaks paths
    like "C:\\Program Files", so only a JSON array is accepted, passed on as {cmd, args}."""
    try:
        argv = json.loads(raw)
    except ValueError:
        raise SigningError(
            'HANGAR_NOTE_SIGN_COMMAND must be a JSON array, e.g. ["signtool.exe", "sign", ..., "%1"].'
        ) from None
    if not isinstance(argv, list) or len(argv) < 2 or not all(isinstance(part, str) and part for part in argv):
        raise SigningError("HANGAR_NOTE_SIGN_COMMAND must be a JSON array of at least two non-empty strings.")
    if not any("%1" in part for part in argv[1:]):
        raise SigningError('HANGAR_NOTE_SIGN_COMMAND needs an argument containing "%1" (the file).')
    return {"cmd": argv[0], "args": argv[1:]}


def unsigned_build_problem(signing, allow_unsigned):
    """Why --version must not build, or None. Unsigned only when the owner says so explicitly."""
    if signing is None and not allow_unsigned:
        return (
            "no Authenticode signing set up (HANGAR_NOTE_CERT_THUMBPRINT or HANGAR_NOTE_SIGN_COMMAND). "
            "Set one, or pass --allow-unsigned to build an unsigned installer on purpose."
        )
    return None


# Prints only the status and whether a timestamp is present. The path comes in through the
# environment so it never has to be spliced into PowerShell source and quoted.
VERIFY_SCRIPT = (
    "$s = Get-AuthenticodeSignature -LiteralPath $env:HANGAR_NOTE_VERIFY_PATH; "
    "[pscustomobject]@{ Status = [string]$s.Status; "
    "Timestamped = [bool]$s.TimeStamperCertificate } | ConvertTo-Json -Compress"
)


def signature_problem(report_text):
    """Evaluates the JSON output of VERIFY_SCRIPT: None for a valid, timestamped signature,
    otherwise the reason."""
    try:
        report = json.loads(report_text)
    except ValueError:
        return "output of Get-AuthenticodeSignature is not readable"
    if not isinstance(report, dict):
        return "output of Get-AuthenticodeSignature is not readable"
    status = report.get("Status")
    if status != "Valid":
        return "signature status %s instead of Valid" % (status if isinstance(status, str) else "unknown")
    if report.get("Timestamped") is not True:
        return "signature without timestamp (becomes invalid when the certificate expires)"
    return None


def authenticode_problem(path):
    """None when `path` carries a valid, timestamped Authenticode signature, otherwise why not."""
    if os.name != "nt":
        return "Authenticode can only be checked on Windows"
    shell = find_tool("pwsh", "powershell")
    if shell is None:
        return "neither pwsh nor powershell found on PATH to check the signature"
    env = without_secrets(os.environ)
    env["HANGAR_NOTE_VERIFY_PATH"] = str(path)
    result = subprocess.run(
        [shell, "-NoProfile", "-NonInteractive", "-Command", VERIFY_SCRIPT],
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return "Get-AuthenticodeSignature failed: %s" % result.stderr.strip()
    return signature_problem(result.stdout.strip())


def require_signature(path, allow_unsigned):
    """Aborts on an unsigned installer unless --allow-unsigned; returns whether it is signed."""
    problem = authenticode_problem(path)
    if problem is None:
        print("Signature valid, with timestamp: %s" % path.name)
        return True
    if not allow_unsigned:
        fail(
            "%s is not validly signed (%s). Sign it, or pass --allow-unsigned to publish it unsigned "
            "on purpose." % (path.name, problem)
        )
    warn_unsigned(path.name)
    return False


# ---------------------------------------------------------------------------------------------
# Programs and environments


def is_inside(path, folder):
    """Whether `path` is `folder` or lies below it (Windows: ignoring case)."""
    inner = os.path.normcase(os.path.abspath(path))
    outer = os.path.normcase(os.path.abspath(folder))
    try:
        return os.path.commonpath([inner, outer]) == outer
    except ValueError:
        # Different drives.
        return False


def find_program(name, search_path, excluded, windows, working_folder=None):
    """The first `name` in an absolute folder of `search_path` outside every `excluded` folder.

    Windows looks for programs in the working folder before PATH and prefers `.com` over `.exe`;
    a file planted in the repository could then run instead of git or node. So only `<name>.exe`
    counts there (a .cmd or .bat would also run through cmd.exe), relative PATH entries are
    skipped, folders inside `excluded` (the repository) never count, also not through a link, and
    neither does `working_folder` itself.
    """
    program = name + ".exe" if windows else name
    excluded = [Path(folder).resolve() for folder in excluded]
    working = os.path.normcase(str(Path(working_folder).resolve())) if working_folder else None
    for entry in search_path.split(os.pathsep):
        entry = entry.strip().strip('"')
        if not entry or not os.path.isabs(entry):
            continue
        try:
            folder = Path(entry).resolve(strict=True)
        except OSError:
            continue
        candidate = folder / program
        if not candidate.is_file() or (not windows and not os.access(candidate, os.X_OK)):
            continue
        real = candidate.resolve()
        if any(is_inside(path, other) for path in (folder, real) for other in excluded):
            continue
        if working in (os.path.normcase(str(folder)), os.path.normcase(str(real.parent))):
            continue
        return str(candidate)
    return None


def find_tool(*names):
    """Absolute path of the first of `names` on PATH, or None."""
    try:
        working_folder = Path.cwd()
    except OSError:
        working_folder = None
    for name in names:
        found = find_program(name, os.environ.get("PATH", ""), [ROOT], os.name == "nt", working_folder)
        if found:
            return found
    return None


def resolve_tool(*names):
    """Absolute path of the first of `names` on PATH; aborts when none is there."""
    found = find_tool(*names)
    if found is None:
        fail(
            "%s not found on PATH (programs in the repository or the working folder are never used)"
            % " or ".join(names)
        )
    return found


def is_secret_variable(name):
    upper = name.upper()
    return upper.endswith(SECRET_SUFFIX) or upper.startswith(SECRET_PREFIX) or upper in SIGNING_VARIABLES


def without_secrets(environ, keep=()):
    """A copy of `environ` without tokens, Tauri's updater key variables and the signing settings
    (Windows names ignore case); `keep` names variables that stay (gh needs its own token)."""
    kept = {name.upper() for name in keep}
    return {
        name: value for name, value in environ.items() if name.upper() in kept or not is_secret_variable(name)
    }


def git_environment(environ, allow_ssh=False):
    """The environment of every git call: no secrets and no GIT_* variable, through which GIT_DIR,
    GIT_INDEX_FILE or GIT_CONFIG_* would point git at another repository or config. A push or
    ls-remote (`allow_ssh`) keeps the variables that choose the SSH program."""
    return {
        name: value
        for name, value in without_secrets(environ).items()
        if not name.upper().startswith("GIT_") or (allow_ssh and name.upper() in GIT_SSH_VARIABLES)
    }


def git_run(*args, allowed=(0,), network=False):
    """Runs git in ROOT and returns the finished process; aborts on an exit code outside `allowed`.

    `core.fsmonitor=false` and a hooks path below a regular file (git itself, where no folder can
    exist) switch off the programs a repository's config can make git run on its own; the command
    line wins over every config file. `tag.gpgSign=false` keeps `git tag` from starting a signer.
    """
    program = resolve_tool("git")
    command = [
        program,
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=" + program,
        "-c",
        "tag.gpgSign=false",
        *args,
    ]
    result = subprocess.run(
        command,
        cwd=ROOT,
        env=git_environment(os.environ, allow_ssh=network),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode not in allowed:
        fail("git %s failed: %s" % (args[0], result.stderr.strip()))
    return result


def git(*args):
    return git_run(*args).stdout.strip()


# Settings through which a repository makes git run a program on a file (clean, smudge, process).
FILTER_KEYS = r"^filter\..*\.(clean|smudge|process)$"


def filter_overrides(config_output):
    """`-c` arguments that switch off every filter driver `git config -z --get-regexp` listed.
    None when a driver name cannot be passed back through `-c`, which splits at the first `=`."""
    names = set()
    for record in config_output.split("\0"):
        key = record.split("\n", 1)[0]
        if not key:
            continue
        name = key[len("filter.") :].rpartition(".")[0] if key.startswith("filter.") else ""
        if not name or "=" in name:
            return None
        names.add(name)
    overrides = []
    for name in sorted(names):
        for setting in ("clean=", "smudge=", "process=", "required=false"):
            overrides += ["-c", "filter.%s.%s" % (name, setting)]
    return overrides


def working_tree_dirty():
    """Whether `git status` reports any change, untracked files included, without running a
    program the repository names (filters are read first and switched off)."""
    config = git_run("config", "-z", "--get-regexp", FILTER_KEYS, allowed=(0, 1))
    overrides = filter_overrides(config.stdout if config.returncode == 0 else "")
    if overrides is None:
        fail("the repository configures a filter whose name git cannot switch off; check .git/config")
    status = git_run(
        *overrides,
        "--no-optional-locks",
        "status",
        "--porcelain",
        "--ignore-submodules=all",
        "--untracked-files=all",
    )
    return bool(status.stdout.strip())


# ---------------------------------------------------------------------------------------------
# Build inputs Git does not see

# Tauri merges these into tauri.conf.json (platform files, TOML and JSON5 forms).
TAURI_CONFIG_OVERRIDE = re.compile(r"^tauri(\.[^.]+)?\.(conf\.json5?|toml)$", re.IGNORECASE)
# Read by Cargo and rustup in the build folder and every folder above it.
CARGO_INPUTS = (
    Path(".cargo") / "config",
    Path(".cargo") / "config.toml",
    Path("rust-toolchain"),
    Path("rust-toolchain.toml"),
)


def build_input_problems(root, ancestors=None):
    """Files that change the build although `git status` may not show them: Tauri config
    overrides next to tauri.conf.json, Cargo configs and toolchain files in src-tauri, the
    repository and every folder above it (`ancestors`, default all up to the drive root) and an
    .npmrc in the repository."""
    root = Path(root)
    tauri_dir = root / "src-tauri"
    found = []
    if tauri_dir.is_dir():
        found += sorted(
            path
            for path in tauri_dir.iterdir()
            if TAURI_CONFIG_OVERRIDE.match(path.name) and path.name != "tauri.conf.json"
        )
    if ancestors is None:
        ancestors = list(root.resolve().parents)
    for folder in [tauri_dir, root, *ancestors]:
        for name in CARGO_INPUTS:
            # lexists: a dangling link or a folder in its place counts as well.
            if os.path.lexists(folder / name):
                found.append(folder / name)
    if os.path.lexists(root / ".npmrc"):
        found.append(root / ".npmrc")
    return found


def tracked_build_inputs(paths):
    """The `paths` Git tracks in this repository; a tracked file shows up in `git status`."""
    inside = {}
    for path in paths:
        try:
            inside[Path(path).resolve().relative_to(ROOT).as_posix()] = path
        except ValueError:
            continue
    if not inside:
        return set()
    listed = git_run("ls-files", "-z", "--", *inside).stdout
    return {inside[name] for name in listed.split("\0") if name in inside}


def check_build_inputs():
    found = build_input_problems(ROOT)
    known = tracked_build_inputs(found)
    found = [path for path in found if path not in known]
    if found:
        fail(
            "these files would change the build but Git does not check them; move them away or "
            "release from a fresh clone:\n  %s" % "\n  ".join(str(path) for path in found)
        )


# ---------------------------------------------------------------------------------------------
# Version files and changelog


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def current_version():
    return read_json(TAURI_CONF)["version"]


def replace_json_version(text, version):
    """`text` with the top-level "version" replaced, or None. Only the value changes: json.dump
    would reformat the file and `pnpm format:check` would then fail."""
    updated, count = re.subn(r'(?m)^(  "version":\s*")[^"]*(")', r"\g<1>" + version + r"\g<2>", text, count=1)
    if count != 1 or json.loads(updated).get("version") != version:
        return None
    return updated


def replace_cargo_version(text, version):
    """Cargo.toml with the version of the [package] section replaced (not a dependency's), or None."""
    updated, count = re.subn(
        r'(\[package\][^\[]*?\nversion\s*=\s*")[^"]+(")', r"\g<1>" + version + r"\g<2>", text, count=1
    )
    return updated if count == 1 else None


def replace_lock_version(text, version):
    """Cargo.lock with the version of this crate's package entry replaced, or None."""
    updated, count = re.subn(
        r'(\[\[package\]\]\r?\nname = "%s"\r?\nversion = ")[^"]+(")' % re.escape(CRATE_NAME),
        r"\g<1>" + version + r"\g<2>",
        text,
        count=1,
    )
    return updated if count == 1 else None


def set_version(version):
    """Writes `version` into the four version files; checks all of them before writing any."""
    edits = []
    for path, replace in (
        (TAURI_CONF, replace_json_version),
        (PACKAGE_JSON, replace_json_version),
        (CARGO_TOML, replace_cargo_version),
        (CARGO_LOCK, replace_lock_version),
    ):
        updated = replace(path.read_text(encoding="utf-8"), version)
        if updated is None:
            fail("version not found in %s" % path.relative_to(ROOT).as_posix())
        edits.append((path, updated))
    for path, updated in edits:
        path.write_text(updated, encoding="utf-8", newline="\n")


def read_changelog():
    try:
        entries = read_json(CHANGELOG_JSON)
    except (OSError, ValueError) as error:
        fail("changelog %s is not readable: %s" % (CHANGELOG_JSON, error))
    if not isinstance(entries, list):
        fail("changelog %s is not a list" % CHANGELOG_JSON)
    return entries


def find_entry(entries, version):
    for entry in entries:
        if isinstance(entry, dict) and entry.get("version") == version:
            return entry
    return None


def changelog_notes(entry):
    """The English items of `entry` as a Markdown list; None when it has none. English because the
    release pages belong to the public repository."""
    items = entry.get("items") if isinstance(entry, dict) else None
    lines = []
    for item in items if isinstance(items, list) else []:
        text = item.get("en") if isinstance(item, dict) else None
        if isinstance(text, str) and text.strip():
            lines.append("- " + text.strip())
    return "\n".join(lines) if lines else None


UNSIGNED_NOTE = (
    "This build is not code-signed yet. Check the installer against SHA256SUMS.txt before you "
    "run it, for example with `Get-FileHash` or `sha256sum -c SHA256SUMS.txt --ignore-missing`."
)


def release_notes(entry, signed):
    """The text of the release page: the changelog items, plus a warning when unsigned."""
    notes = changelog_notes(entry)
    if notes is None:
        fail("changelog entry %s has no English items" % entry.get("version"))
    if not signed:
        notes += "\n\n" + UNSIGNED_NOTE
    return notes


def build_number_from(package, commit_count):
    """buildNumberBase from package.json plus the commit count (ADR 0003). Hangar Note has no
    base, so a missing field counts as 0."""
    base = package.get("buildNumberBase", 0)
    if not isinstance(base, int) or isinstance(base, bool) or base < 0:
        fail("buildNumberBase in package.json must be a whole number >= 0.")
    return base + commit_count


def commit_count(revision="HEAD"):
    return int(git("rev-list", "--count", revision))


def build_number():
    return build_number_from(read_json(PACKAGE_JSON), commit_count())


def parse_version(version):
    """((X, Y, Z), build number or None); None if the text does not fit the scheme."""
    match = FULL_VERSION.match(version) if isinstance(version, str) else None
    if not match:
        return None
    build = match.group(4)
    return tuple(int(part) for part in match.group(1, 2, 3)), (int(build) if build is not None else None)


def dotted(version_tuple):
    return ".".join(map(str, version_tuple))


def display(internal):
    """0.1.0+14 -> 0.1.0-14 (shown and in file names; '+' breaks download URLs)."""
    return internal.replace("+", "-")


def tag_name(base_version):
    """0.1.0 -> v0.1.0. The tag names the release, not the build."""
    return "v%s" % base_version


def installer_name(version):
    return "Hangar-Note_%s_x64-setup.exe" % display(version)


def release_title(version):
    return "%s %s" % (PRODUCT, display(version))


def changelog_versions(entries):
    """(version as a tuple, date or None) for every readable entry."""
    found = []
    for entry in entries if isinstance(entries, list) else []:
        version = entry.get("version") if isinstance(entry, dict) else None
        if isinstance(version, str) and BASE_VERSION.match(version):
            found.append((tuple(int(part) for part in version.split(".")), entry.get("date")))
    return found


def release_folders(release_dir):
    """{folder name: (X, Y, Z)} for every X.Y.Z-B or X.Y.Z folder under release/."""
    found = {}
    if release_dir.is_dir():
        for child in release_dir.iterdir():
            parsed = parse_version(child.name.replace("-", "+", 1)) if child.is_dir() else None
            if parsed is not None:
                found[child.name] = parsed[0]
    return found


def last_published(entries, release_dir):
    """Highest released version: a dated changelog entry or a folder under release/ (missing in a
    fresh clone, while the changelog date only arrives with the release commit)."""
    found = [version for version, date in changelog_versions(entries) if date is not None]
    found += list(release_folders(release_dir).values())
    return max(found) if found else None


def release_problem(version, file_version, entries, release_dir):
    """Why --version X.Y.Z is not allowed, or None (rule "the code always carries the upcoming
    version", ADR 0003)."""
    if not BASE_VERSION.match(version):
        return "--version expects X.Y.Z, e.g. 0.1.0 (the script adds the build number)"
    new = tuple(int(part) for part in version.split("."))
    existing = sorted(name for name, found in release_folders(release_dir).items() if found == new)
    if existing:
        return "release/%s exists already; delete it to build %s again." % (existing[0], version)
    versions = changelog_versions(entries)
    if not versions:
        return "src/changelog.json has no entry; add the upcoming version there."
    highest = max(version_tuple for version_tuple, _ in versions)
    if new != highest:
        return "--version %s must be the highest version in src/changelog.json (%s)." % (version, dotted(highest))
    parsed = parse_version(file_version)
    if parsed is None:
        return "version '%s' in tauri.conf.json does not match the scheme X.Y.Z or X.Y.Z+Build" % file_version
    if new < parsed[0]:
        return "--version %s is lower than the version in the files (%s)." % (version, dotted(parsed[0]))
    published = last_published(entries, release_dir)
    if published is not None and new <= published:
        return "%s must be higher than the released %s." % (version, dotted(published))
    return None


def next_problem(version, file_version, entries, release_dir):
    """Why --next X.Y.Z is not allowed, or None. The highest version so far must be released
    (dated), and the new one must be higher than everything before it."""
    if not BASE_VERSION.match(version):
        return "--next expects X.Y.Z, e.g. 0.2.0"
    new = tuple(int(part) for part in version.split("."))
    versions = changelog_versions(entries)
    if versions:
        highest, date = max(versions, key=lambda pair: pair[0])
        if date is None:
            return "%s is not released yet (changelog entry without date); release it first." % dotted(highest)
        if new <= highest:
            return "--next %s must be higher than %s in the changelog." % (version, dotted(highest))
    parsed = parse_version(file_version)
    if parsed is not None and new <= parsed[0]:
        return "--next %s must be higher than the version in the files (%s)." % (version, file_version)
    published = last_published(entries, release_dir)
    if published is not None and new <= published:
        return "--next %s must be higher than the released %s." % (version, dotted(published))
    return None


def with_next_entry(entries, version):
    """Changelog with an empty, undated entry for the upcoming version at the top."""
    return [{"version": version, "date": None, "items": []}, *entries]


def suggest_next(version):
    """Suggestion after a release: the next minor version, 0.1.0 -> 0.2.0."""
    major, minor, _ = (int(part) for part in version.split("."))
    return "%d.%d.0" % (major, minor + 1)


def release_commit_problem(head_count, build, changed_files):
    """Why HEAD is not the release commit of build `build`, or None.

    The build ran on a clean tree at `build` commits; the release commit adds exactly one commit
    that changes only the version files and the changelog. So the tag names the built source.
    """
    if head_count != build + 1:
        return (
            "HEAD has %d commits; the release commit of build %d must be commit %d (exactly one "
            "commit with the version files after the built state)" % (head_count, build, build + 1)
        )
    extra = sorted(set(changed_files) - VERSION_FILES)
    if extra:
        return "the release commit changes more than the version files: %s" % ", ".join(extra)
    return None


def print_commit_hint(files, message):
    print("Commit these files now (the script never commits):")
    print("  git add %s" % " ".join(sorted(files)))
    print('  git commit -m "%s"' % message)


def prepare_next(version, dry_run):
    """--next: the files to the upcoming version (without build number), plus the changelog entry."""
    entries = read_changelog()
    problem = next_problem(version, current_version(), entries, RELEASE_DIR)
    if problem:
        fail(problem)
    if dry_run:
        print("Dry run: would set the version files to %s and add it empty to src/changelog.json." % version)
        return
    set_version(version)
    write_json(CHANGELOG_JSON, with_next_entry(entries, version))
    print("Upcoming version %s set and added empty to src/changelog.json." % version)
    print_commit_hint(VERSION_FILES, "chore(release): start %s" % version)


# ---------------------------------------------------------------------------------------------
# Checksums


def sha256_hex(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checksums_text(target, names):
    """Lines in the format of `sha256sum` (two spaces, text mode), so `sha256sum -c` accepts them."""
    return "".join("%s  %s\n" % (sha256_hex(target / name), name) for name in names)


def write_checksums(target, names):
    # Bytes instead of text mode: on Windows, text mode would write CRLF, which sha256sum -c rejects.
    (target / CHECKSUMS_NAME).write_bytes(checksums_text(target, names).encode("utf-8"))


# st_file_attributes bit of a symbolic link, junction or other reparse point (Windows).
FILE_ATTRIBUTE_REPARSE_POINT = 0x400


def plain_stat_problem(st, directory=False):
    """Why a stat result (from os.lstat) is no plain file or folder, or None. Links and Windows
    reparse points could point the upload at a file outside release/."""
    if getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT:
        return "is a link or reparse point"
    if directory and not stat.S_ISDIR(st.st_mode):
        return "is not a folder"
    if not directory and not stat.S_ISREG(st.st_mode):
        return "is not a regular file"
    return None


def read_plain_file(path):
    """The bytes of `path`, read once; raises ValueError when it is missing, a link, a reparse
    point or was swapped between the check and the read."""
    try:
        before = os.lstat(path)
    except FileNotFoundError:
        raise ValueError("is missing") from None
    problem = plain_stat_problem(before)
    if problem:
        raise ValueError(problem)
    with open(path, "rb") as handle:
        if not os.path.samestat(before, os.fstat(handle.fileno())):
            raise ValueError("changed while it was opened")
        return handle.read()


def release_folder_problem(target, release_root):
    """Why `target` is no plain folder inside `release_root`, or None."""
    try:
        problem = plain_stat_problem(os.lstat(target), directory=True)
    except FileNotFoundError:
        return "%s is missing" % target
    if problem:
        return "%s %s" % (target, problem)
    if not is_inside(Path(target).resolve(), Path(release_root).resolve()):
        return "%s is not inside %s" % (target, release_root)
    return None


Asset = collections.namedtuple("Asset", "name data sha256")


def read_release_files(target, installer, release_root):
    """([installer, SHA256SUMS.txt] as Assets, problems). SHA256SUMS.txt must list exactly the
    installer; each file is read once, so the bytes whose hash was checked are the bytes that are
    uploaded."""
    problem = release_folder_problem(target, release_root)
    if problem:
        return [], [problem]
    try:
        sums = read_plain_file(Path(target) / CHECKSUMS_NAME)
        text = sums.decode("utf-8")
    except (ValueError, OSError, UnicodeDecodeError) as error:
        return [], ["%s %s" % (CHECKSUMS_NAME, error)]
    listed, problems = [], []
    for line in text.split("\n"):
        if not line:
            continue
        match = CHECKSUM_LINE.match(line)
        if not match or not ASSET_NAME.match(match.group(2)):
            problems.append("%s has an unreadable line: %r" % (CHECKSUMS_NAME, line[:120]))
            continue
        listed.append(match.groups())
    if [name for _, name in listed] != [installer]:
        problems.append("%s must list exactly %s" % (CHECKSUMS_NAME, installer))
    if problems:
        return [], problems
    expected = listed[0][0]
    try:
        data = read_plain_file(Path(target) / installer)
    except (ValueError, OSError) as error:
        return [], ["%s %s" % (installer, error)]
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected:
        return [], ["%s does not match its SHA-256 in %s" % (installer, CHECKSUMS_NAME)]
    return [Asset(installer, data, digest), Asset(CHECKSUMS_NAME, sums, hashlib.sha256(sums).hexdigest())], []


def read_build_commit(target):
    """The commit id release/<X.Y.Z-B>/BUILD_COMMIT names, or None."""
    try:
        text = read_plain_file(Path(target) / BUILD_COMMIT_NAME).decode("ascii").strip()
    except (ValueError, OSError, UnicodeDecodeError):
        return None
    return text if COMMIT_ID.match(text) else None


# ---------------------------------------------------------------------------------------------
# Building


def locked_cli_version(lock_text):
    """The @tauri-apps/cli version the root importer of pnpm-lock.yaml pins, or None."""
    match = re.search(
        r"(?m)^      '@tauri-apps/cli':\r?\n        specifier: [^\n]*\n        version: ([^\s(]+)", lock_text
    )
    return match.group(1) if match else None


def cli_version_problem(package_text, lock_text):
    """None when the installed CLI has the version the lock file pins, otherwise the reason."""
    locked = locked_cli_version(lock_text)
    if locked is None:
        return "pnpm-lock.yaml names no version of @tauri-apps/cli"
    try:
        installed = json.loads(package_text).get("version")
    except (ValueError, AttributeError):
        installed = None
    if installed != locked:
        return "node_modules has @tauri-apps/cli %s, but pnpm-lock.yaml pins %s; run pnpm install --frozen-lockfile" % (
            installed,
            locked,
        )
    return None


def tauri_command(*args):
    """argv for the Tauri CLI: node.exe with the CLI's tauri.js, then `args`.

    pnpm and npx are .cmd files on Windows; CreateProcess runs those through cmd.exe, which
    interprets `&`, `%` and quotes in every argument (BatBadBut). node.exe takes the argv as is.
    """
    node = resolve_tool("node")
    if not TAURI_JS.is_file():
        fail("Tauri CLI missing: %s (run pnpm install)" % TAURI_JS)
    try:
        problem = cli_version_problem(
            TAURI_CLI_PACKAGE.read_text(encoding="utf-8"), PNPM_LOCK.read_text(encoding="utf-8")
        )
    except OSError as error:
        problem = "Tauri CLI or pnpm-lock.yaml not readable: %s (run pnpm install)" % error
    if problem:
        fail(problem)
    return [node, str(TAURI_JS), *args]


def build(signing):
    command = tauri_command("build", "--bundles", "nsis")
    config_file = None
    try:
        if signing is not None:
            # A file instead of a JSON argument keeps the thumbprint out of the process list; it
            # lives in the git-ignored release/ folder rather than the system temp folder.
            RELEASE_DIR.mkdir(exist_ok=True)
            config_file = RELEASE_DIR / (".signing-config-%s.json" % secrets.token_hex(8))
            with open(config_file, "x", encoding="utf-8") as handle:
                json.dump(signing, handle)
            command += ["--config", str(config_file)]
        result = subprocess.run(command, cwd=ROOT, env=without_secrets(os.environ), check=False)
    finally:
        if config_file is not None:
            config_file.unlink(missing_ok=True)
    if result.returncode != 0:
        fail("tauri build failed (exit code %d)" % result.returncode)


def find_setup(built_after):
    # Tauri names the file after productName and the internal version; only this run's output.
    candidates = [
        path for path in BUNDLE_DIR.glob(PRODUCT + "_*_x64-setup.exe") if path.stat().st_mtime >= built_after
    ]
    if len(candidates) != 1:
        fail("expected exactly one new installer in %s, found: %d" % (BUNDLE_DIR, len(candidates)))
    return candidates[0]


def collect(setup, expected_sha256, version, built_commit):
    """Copies the installer under release/<X.Y.Z-B>/ and writes SHA256SUMS.txt and BUILD_COMMIT;
    the copy must have the hash taken right after the signature check."""
    target = RELEASE_DIR / display(version)
    target.mkdir(parents=True, exist_ok=False)
    name = installer_name(version)
    shutil.copy2(setup, target / name)
    if sha256_hex(target / name) != expected_sha256:
        (target / name).unlink(missing_ok=True)
        fail("%s changed after it was checked; nothing was collected" % setup.name)
    write_checksums(target, [name])
    (target / BUILD_COMMIT_NAME).write_bytes((built_commit + "\n").encode("ascii"))
    return target, name


def release(version, allow_unsigned, dry_run):
    """--version X.Y.Z: checks, dates the changelog, sets X.Y.Z+B, builds and collects."""
    if os.name != "nt":
        fail("--version builds the Windows installer and runs on Windows only")
    try:
        signing = windows_signing_config(os.environ)
    except SigningError as error:
        fail(str(error))
    problem = unsigned_build_problem(signing, allow_unsigned)
    if problem:
        fail(problem)
    entries = read_changelog()
    problem = release_problem(version, current_version(), entries, RELEASE_DIR)
    if problem:
        fail(problem)
    entry = find_entry(entries, version)
    if entry is None or changelog_notes(entry) is None:
        fail("changelog entry %s is missing or has no English items" % version)
    if git_run("rev-parse", "-q", "--verify", "refs/tags/" + tag_name(version), allowed=(0, 1)).returncode == 0:
        fail("tag %s exists already; a released version is never built again" % tag_name(version))
    if working_tree_dirty():
        fail("the working tree is not clean; commit first, so the build number names the built source")
    check_build_inputs()

    full = "%s+%d" % (version, build_number())
    built_commit = git("rev-parse", "HEAD")
    if dry_run:
        print("Dry run, nothing changed. A release would:")
        print("  date the changelog entry %s and set the version files to %s" % (version, full))
        print("  run: tauri build --bundles nsis%s" % ("" if signing is None else " --config <signing>"))
        print("  write release/%s/%s, %s and %s" % (display(full), installer_name(full), CHECKSUMS_NAME, BUILD_COMMIT_NAME))
        if signing is None:
            warn_unsigned("The installer")
        return

    if signing is None:
        warn_unsigned("The installer")
    else:
        print("Authenticode code signing active (setting from the environment, values are not printed).")
    entry["date"] = datetime.date.today().isoformat()
    write_json(CHANGELOG_JSON, entries)
    set_version(full)
    print("Changelog %s dated %s, version %s (shown as %s) set." % (version, entry["date"], full, display(full)))

    started = time.time()
    build(signing)
    setup = find_setup(started)
    checked_sha256 = sha256_hex(setup)
    if signing is not None:
        # Verify instead of trusting that Tauri signed the installer and the program.
        for path in (setup, MAIN_EXE):
            problem = authenticode_problem(path)
            if problem:
                fail("%s is not validly signed: %s" % (path.name, problem))
        if sha256_hex(setup) != checked_sha256:
            fail("%s changed while its signature was checked" % setup.name)
    target, name = collect(setup, checked_sha256, full, built_commit)
    print()
    print("Done: %s (%s, %s)" % (target, name, CHECKSUMS_NAME))
    print_commit_hint(VERSION_FILES, "chore(release): %s" % display(full))
    print("Then publish on Forgejo:")
    print("  py -3 tools/release.py --publish forgejo%s" % (" --allow-unsigned" if signing is None else ""))
    print("After the go for GitHub (also after --next):")
    print("  py -3 tools/release.py --publish github --release %s" % version)
    print("Then start the upcoming version:")
    print("  py -3 tools/release.py --next %s" % suggest_next(version))


# ---------------------------------------------------------------------------------------------
# Remotes and pushing

Remote = collections.namedtuple("Remote", "host port owner repo")

_SSH_URL = re.compile(r"^ssh://(?:[^@/]+@)?(\[[^\]]+\]|[^/:@]+)(?::(\d+))?/(.+)$", re.IGNORECASE)
_HTTPS_URL = re.compile(r"^https://([^/@]+@)?(\[[^\]]+\]|[^/:@]+)(?::(\d+))?/(.+)$", re.IGNORECASE)
_SCP_URL = re.compile(r"^(?:[^@/]+@)?([A-Za-z0-9.-]+\.[A-Za-z0-9-]+):(?!/)(.+)$")


def parse_remote_url(url):
    """Remote(host, port, owner, repo) of an ssh://, scp-like or https:// Git URL.

    Raises ValueError without repeating the URL, which may carry credentials.
    """
    url = (url or "").strip()
    match = _SSH_URL.match(url)
    if match:
        host, port, path = match.groups()
    else:
        match = _HTTPS_URL.match(url)
        if match:
            if match.group(1):
                raise ValueError("the remote URL carries credentials; remove them from the Git config")
            host, port, path = match.group(2, 3, 4)
        else:
            match = _SCP_URL.match(url)
            if not match:
                raise ValueError("the remote URL is neither ssh://, https:// nor host:owner/repo")
            host, path = match.groups()
            port = None
    path = path.rstrip("/")
    if path.endswith(".git"):
        path = path[: -len(".git")]
    parts = path.split("/")
    if len(parts) != 2 or not all(REPO_PART.match(part) for part in parts):
        raise ValueError("the remote URL does not end in <owner>/<repository>")
    return Remote(host.lower(), int(port) if port else None, parts[0], parts[1])


def push_command(destination, commit, tag):
    """`git push` arguments for `commit` as main plus `tag`, atomically, to a URL.

    Only URLs: a remote name may have several push URLs (origin pushes to Forgejo and GitHub), so
    `git push origin` would publish on both. Raises ValueError for anything that is no URL.
    """
    if not isinstance(destination, str) or destination.startswith("-"):
        raise ValueError("push destination must be a URL")
    try:
        parse_remote_url(destination)
    except ValueError:
        raise ValueError("push destination must be a URL, never a remote name such as origin") from None
    if not re.match(r"^[0-9a-f]{40}([0-9a-f]{24})?$", commit or ""):
        raise ValueError("push needs a full commit id")
    if not re.match(r"^v\d+\.\d+\.\d+$", tag or ""):
        raise ValueError("push needs a tag vX.Y.Z")
    return [
        "push",
        "--atomic",
        "--porcelain",
        destination,
        "%s:refs/heads/main" % commit,
        "refs/tags/%s:refs/tags/%s" % (tag, tag),
    ]


def remote_tag_exists(url, tag):
    listed = git_run("ls-remote", "--tags", url, "refs/tags/" + tag, network=True).stdout
    return bool(listed.strip())


def local_tag_commit(tag):
    result = git_run("rev-parse", "-q", "--verify", "refs/tags/%s^{commit}" % tag, allowed=(0, 1))
    return result.stdout.strip() if result.returncode == 0 else None


# Settings through which git would send a push or ls-remote somewhere else than the URL given.
REDIRECT_KEYS = r"^(remote\..*\.(url|pushurl)|url\..*\.(insteadof|pushinsteadof))$"
# Settings that choose the programs git hands the SSH connection or credentials to.
CREDENTIAL_KEYS = r"^(core\.sshcommand|core\.askpass|credential\..*)$"


def redirect_config_problems(config_output, host, url):
    """Why the Git config could send a push to `url` elsewhere: a remote whose name looks like a
    URL (git would take it for the remote and use its URLs) or an insteadOf / pushInsteadOf rule
    that mentions `host` or matches the start of `url`. Reads `git config -z --get-regexp`
    output; names the setting, never its value."""
    problems = []
    for record in config_output.split("\0"):
        key, _, value = record.partition("\n")
        lower = key.lower()
        if lower.startswith("remote."):
            name = key[len("remote.") :].rpartition(".")[0]
            if ":" in name or "/" in name:
                problems.append("a remote is named like a URL (%s)" % lower.rpartition(".")[2])
        elif lower.startswith("url."):
            base = key[len("url.") :].rpartition(".")[0]
            rule = lower.rpartition(".")[2]
            if host.lower() in (base + "\n" + value).lower() or (value and url.startswith(value)):
                problems.append("a url.*.%s rule rewrites URLs of %s" % (rule, host))
    return problems


def repository_config_problems(show_origin_output, root, local=False):
    """Settings of CREDENTIAL_KEYS that come from the repository's own config: whoever can write
    the repository could make git start a program with the push credentials. Reads
    `git config --show-origin -z` output. With `local` the output is that of
    `git config --local --includes`, so every file entry counts: .git/config, a file it includes
    from anywhere, and the main repository's config of a linked worktree. Otherwise only files
    inside `root` count."""
    records = show_origin_output.split("\0")
    problems = []
    for origin, entry in zip(records[0::2], records[1::2]):
        if not origin.startswith("file:"):
            continue
        path = Path(origin[len("file:") :])
        if not path.is_absolute():
            path = Path(root) / path
        if local or is_inside(path, root):
            problems.append("%s is set in %s" % (entry.partition("\n")[0], origin[len("file:") :]))
    return problems


def check_push_config(host, url):
    """Aborts when the Git config could redirect the push or hand it to a repository program."""
    listed = git_run("config", "-z", "--get-regexp", REDIRECT_KEYS, allowed=(0, 1))
    problems = redirect_config_problems(listed.stdout if listed.returncode == 0 else "", host, url)
    listed = git_run("config", "--show-origin", "-z", "--get-regexp", CREDENTIAL_KEYS, allowed=(0, 1))
    found = repository_config_problems(listed.stdout if listed.returncode == 0 else "", ROOT)
    listed = git_run(
        "config", "--local", "--includes", "--show-origin", "-z", "--get-regexp", CREDENTIAL_KEYS, allowed=(0, 1)
    )
    found += repository_config_problems(listed.stdout if listed.returncode == 0 else "", ROOT, local=True)
    problems += sorted(set(found))
    if problems:
        fail("the Git config could send the push elsewhere; nothing was pushed:\n  %s" % "\n  ".join(problems))


def anonymized(url):
    """`url` without user information, as git may print it after a push."""
    match = re.match(r"^([a-z][a-z0-9+.-]*://)[^@/]+@(.*)$", url, re.IGNORECASE)
    if match:
        return match.group(1) + match.group(2)
    match = re.match(r"^[^@/:]+@([^/:]+:.*)$", url)
    return match.group(1) if match else url


def porcelain_destination_problem(output, url):
    """Why `git push --porcelain` output does not show a push to exactly `url`, or None."""
    targets = [line[len("To ") :].strip() for line in output.splitlines() if line.startswith("To ")]
    if not targets:
        return "git push reported no destination"
    if any(target not in (url, anonymized(url)) for target in targets):
        return "git pushed to another URL than the expected one; check the Git config"
    return None


def push(url, commit, tag, where, on_failure=""):
    """Pushes `commit` as main and `tag` to `url`; `on_failure` is added to the error message."""
    print("Pushing %s as main and %s to %s ..." % (commit[:12], tag, where))
    result = git_run(*push_command(url, commit, tag), allowed=tuple(range(256)), network=True)
    if result.returncode != 0:
        fail("git push to %s failed: %s%s" % (where, result.stderr.strip(), on_failure))
    output = result.stdout
    problem = porcelain_destination_problem(output, url)
    if problem:
        fail(problem)


# ---------------------------------------------------------------------------------------------
# Forgejo API


class ForgejoError(Exception):
    """A failed API call. Messages never contain the token."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuses every redirect, so the Authorization header never follows to another URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def default_opener():
    return urllib.request.build_opener(
        _NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context())
    )


def api_base(base_url):
    """The Forgejo URL as the API root (https only, no credentials, query or fragment)."""
    parts = urllib.parse.urlsplit((base_url or "").strip())
    if parts.scheme != "https" or not parts.hostname:
        raise ForgejoError("the Forgejo URL must start with https://")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ForgejoError("the Forgejo URL must not carry credentials, a query or a fragment")
    return urllib.parse.urlunsplit(("https", parts.netloc, parts.path.rstrip("/"), "", "")) + "/api/v1"


def api_host(base_url):
    return urllib.parse.urlsplit(base_url.strip()).hostname


TOKEN = re.compile(r"^[\x21-\x7e]+$")
ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def parse_env_text(text):
    """KEY=VALUE pairs of a .env file. Plain text only: no code runs, no variable expansion.
    Blank lines and lines starting with # are skipped, an `export ` prefix is allowed, and one pair
    of matching quotes around the value is removed; an unquoted value ends before " #" (a
    comment). Lines that do not fit are ignored."""
    values = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, sep, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not sep or not ENV_KEY.match(key):
            continue
        if value[:1] in ("'", '"'):
            closing = value.find(value[0], 1)
            if closing > 0:
                value = value[1:closing]
        else:
            value = re.split(r"\s#", value, maxsplit=1)[0].rstrip()
        values[key] = value
    return values


def read_dotenv(path):
    """The pairs of the git-ignored .env in the repository root; {} when it is missing."""
    try:
        return parse_env_text(Path(path).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError):
        fail("%s is not readable as UTF-8 text" % Path(path).name)


ForgejoSettings = collections.namedtuple("ForgejoSettings", "base_url url_source token token_source")


def forgejo_settings(environ, dotenv, origin_host):
    """Where the API root and the token come from: FORGEJO_URL and FORGEJO_TOKEN, each from the
    environment first and then from .env; without a URL, https://<host of origin> (an SSH port is
    no web port, so it is left out). The sources are names only, so they can be printed; the
    token itself never is."""
    found = {}
    for name in ("FORGEJO_URL", "FORGEJO_TOKEN"):
        found[name] = (None, None)
        for source, values in (("environment", environ), (".env", dotenv)):
            value = values.get(name, "").strip()
            if value:
                found[name] = (value, "%s from %s" % (name, source))
                break
    base_url, url_source = found["FORGEJO_URL"]
    if not base_url:
        base_url, url_source = "https://%s" % origin_host, "host of origin"
    token, token_source = found["FORGEJO_TOKEN"]
    return ForgejoSettings(base_url, url_source, token, token_source)


def release_request_body(tag, title, notes, prerelease, commit):
    """Body of POST /repos/{owner}/{repo}/releases. Always a draft first: it is published only
    once every file is attached."""
    return {
        "tag_name": tag,
        "target_commitish": commit,
        "name": title,
        "body": notes,
        "draft": True,
        "prerelease": bool(prerelease),
    }


def multipart_body(field, filename, data, boundary=None):
    """(body, content type) of a multipart/form-data upload with one file."""
    if not ASSET_NAME.match(filename):
        raise ValueError("asset names are plain file names")
    while boundary is None or boundary.encode("ascii") in data:
        boundary = "hangar-note-" + secrets.token_hex(16)
    head = (
        '--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n" % (boundary, field, filename)
    ).encode("ascii")
    tail = ("\r\n--%s--\r\n" % boundary).encode("ascii")
    return head + data + tail, "multipart/form-data; boundary=%s" % boundary


class ForgejoClient:
    def __init__(self, base_url, token, owner, repo, opener=None):
        self._api = api_base(base_url)
        if not isinstance(token, str) or not TOKEN.match(token):
            raise ForgejoError("the Forgejo token is missing or contains spaces or control characters")
        if not (REPO_PART.match(owner or "") and REPO_PART.match(repo or "")):
            raise ForgejoError("owner or repository name is not valid")
        self._token = token
        self._opener = opener or default_opener()
        self.repo_path = "/repos/%s/%s" % (owner, repo)

    def _redact(self, text):
        return text.replace(self._token, "***") if self._token else text

    def request(self, method, path, data=None, content_type=None, ok=(200,), missing_ok=False):
        """JSON answer of `method path`; None for 404 when `missing_ok`. Raises ForgejoError."""
        request = urllib.request.Request(self._api + path, data=data, method=method)
        # Unredirected: never copied to a redirect target, should a redirect ever get through.
        request.add_unredirected_header("Authorization", "token " + self._token)
        request.add_header("Accept", "application/json")
        if content_type:
            request.add_header("Content-Type", content_type)
        try:
            with self._opener.open(request, timeout=API_TIMEOUT) as response:
                status, payload = response.status, response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            try:
                payload = error.read() or b""
            except OSError:
                payload = b""
            finally:
                error.close()
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as error:
            reason = getattr(error, "reason", error)
            raise ForgejoError(self._redact("%s %s failed: %s" % (method, path, reason))) from None
        if status == 404 and missing_ok:
            return None
        if status not in ok:
            raise ForgejoError(
                self._redact("Forgejo answered %d to %s %s: %s" % (status, method, path, _api_message(payload)))
            )
        try:
            return json.loads(payload.decode("utf-8")) if payload else {}
        except (UnicodeDecodeError, ValueError):
            raise ForgejoError("Forgejo answered %s %s with something that is not JSON" % (method, path)) from None

    def repository(self):
        return self.request("GET", self.repo_path)

    def release_by_tag(self, tag):
        return self.request(
            "GET", "%s/releases/tags/%s" % (self.repo_path, urllib.parse.quote(tag, safe="")), missing_ok=True
        )

    def create_release(self, body):
        data = json.dumps(body).encode("utf-8")
        return self.request(
            "POST", self.repo_path + "/releases", data=data, content_type="application/json", ok=(201,)
        )

    def upload_asset(self, release_id, name, data):
        """Uploads exactly `data` as `name`; the server must report the same size."""
        body, content_type = multipart_body("attachment", name, data)
        answer = self.request(
            "POST",
            "%s/releases/%d/assets?name=%s" % (self.repo_path, int(release_id), urllib.parse.quote(name)),
            data=body,
            content_type=content_type,
            ok=(201,),
        )
        if not isinstance(answer, dict) or answer.get("size") != len(data):
            raise ForgejoError("Forgejo stored %s with another size than the local file" % name)
        return answer

    def publish_release(self, release_id):
        data = json.dumps({"draft": False}).encode("utf-8")
        return self.request(
            "PATCH",
            "%s/releases/%d" % (self.repo_path, int(release_id)),
            data=data,
            content_type="application/json",
        )


def repository_push_problem(repository):
    """Why the token may not push to the repository (GET /repos/{owner}/{repo}), or None."""
    permissions = repository.get("permissions") if isinstance(repository, dict) else None
    if not isinstance(permissions, dict) or permissions.get("push") is not True:
        return "the Forgejo token has no push permission for this repository"
    return None


def _api_message(payload):
    try:
        message = json.loads(payload.decode("utf-8")).get("message")
    except (UnicodeDecodeError, ValueError, AttributeError):
        message = None
    if not isinstance(message, str):
        message = payload.decode("utf-8", "replace") if payload else ""
    return message.strip()[:300] or "(no message)"


# ---------------------------------------------------------------------------------------------
# Publishing

Release = collections.namedtuple("Release", "base full target")


def resolve_release(explicit):
    """The built release to publish: X.Y.Z+B from the files while they carry a build number, or the
    one folder release/X.Y.Z-B for `explicit` X.Y.Z (after --next)."""
    parsed = parse_version(current_version())
    if explicit is None:
        if parsed is None or parsed[1] is None:
            fail("the version files carry no build number; name the release with --release X.Y.Z")
        base, full = dotted(parsed[0]), current_version()
    else:
        if not BASE_VERSION.match(explicit):
            fail("--release expects X.Y.Z")
        if parsed is not None and parsed[1] is not None and dotted(parsed[0]) == explicit:
            base, full = explicit, current_version()
        else:
            names = [
                name for name in release_folders(RELEASE_DIR) if re.match(r"^%s-\d+$" % re.escape(explicit), name)
            ]
            if len(names) != 1:
                fail("expected exactly one folder release/%s-<build>, found: %d" % (explicit, len(names)))
            base, full = explicit, names[0].replace("-", "+", 1)
    target = RELEASE_DIR / display(full)
    if not target.is_dir():
        fail("%s is missing; build it with --version %s first" % (target, base))
    return Release(base, full, target)


def checked_files(rel):
    """The installer and SHA256SUMS.txt as Assets, each read once and checked."""
    assets, problems = read_release_files(rel.target, installer_name(rel.full), RELEASE_DIR)
    if problems:
        fail("release/%s is not intact:\n  %s" % (rel.target.name, "\n  ".join(problems)))
    return assets


def recheck(rel, assets, moment):
    """Aborts when a file under release/ no longer has the bytes that were checked."""
    for asset in assets:
        try:
            data = read_plain_file(rel.target / asset.name)
        except (ValueError, OSError) as error:
            fail("%s %s %s" % (asset.name, error, moment))
        if hashlib.sha256(data).hexdigest() != asset.sha256:
            fail("%s changed %s" % (asset.name, moment))


def signed_and_unchanged(rel, assets, allow_unsigned):
    """Checks the installer's Authenticode signature, then that the checked bytes are still the
    ones on disk, so the signature belongs to what is uploaded."""
    signed = require_signature(rel.target / assets[0].name, allow_unsigned)
    recheck(rel, assets, "while its signature was checked")
    return signed


def build_commit_problem(rel, parent):
    """Why `parent` (the commit before the release commit) is not the built commit, or None."""
    built = read_build_commit(rel.target)
    if built is None:
        return "release/%s/%s is missing or unreadable" % (rel.target.name, BUILD_COMMIT_NAME)
    if parent != built:
        return "the release commit does not follow the built commit %s" % built[:12]
    return None


def released_entry(base):
    entry = find_entry(read_changelog(), base)
    if entry is None or entry.get("date") is None:
        fail("changelog entry %s is missing or undated; publish the committed release state" % base)
    return entry


def publish_forgejo(rel, prerelease, draft, allow_unsigned, dry_run):
    try:
        origin = git("remote", "get-url", "origin")
        remote = parse_remote_url(origin)
    except ValueError as error:
        fail("origin: %s" % error)
    if remote.host == GITHUB_HOST:
        fail("the fetch URL of origin points at GitHub; Forgejo must come first")
    settings = forgejo_settings(os.environ, read_dotenv(DOTENV), remote.host)
    try:
        api_base(settings.base_url)
    except ForgejoError as error:
        fail("%s (%s)" % (error, settings.url_source))
    if remote.host != (api_host(settings.base_url) or "").lower():
        fail("the fetch URL of origin does not point at the host of the Forgejo URL (%s)" % settings.url_source)
    if not settings.token:
        fail("no Forgejo token: FORGEJO_TOKEN is set neither in the environment nor in %s" % DOTENV.name)
    print("Forgejo URL: %s; token: %s (value not shown)." % (settings.url_source, settings.token_source))
    if current_version() != rel.full:
        fail(
            "the version files carry %s, not %s; publish on Forgejo from the release commit, before --next"
            % (current_version(), rel.full)
        )
    if git_run("symbolic-ref", "--quiet", "--short", "HEAD", allowed=(0, 1)).stdout.strip() != "main":
        fail("check out main; the release commit goes to main")
    if working_tree_dirty():
        fail("the working tree is not clean; commit the release state first")
    build = parse_version(rel.full)[1]
    changed = git("diff", "--name-only", "-z", "HEAD~1", "HEAD").split("\0")
    problem = release_commit_problem(commit_count(), build, [name for name in changed if name])
    if problem:
        fail(problem)
    problem = build_commit_problem(rel, git("rev-parse", "HEAD~1"))
    if problem:
        fail(problem)
    entry = released_entry(rel.base)
    files = checked_files(rel)
    signed = signed_and_unchanged(rel, files, allow_unsigned)
    notes = release_notes(entry, signed)
    tag = tag_name(rel.base)
    if local_tag_commit(tag) is not None:
        fail("tag %s exists locally already; a release is never overwritten" % tag)
    commit = git("rev-parse", "HEAD")
    check_push_config(remote.host, origin)

    print("Release %s from %s, files:" % (release_title(rel.full), commit[:12]))
    for asset in files:
        print("  %s" % asset.name)
    if dry_run:
        print("Dry run, nothing changed. Publishing would:")
        print("  check push permission and that %s exists neither on Forgejo (%s/%s) nor as a release there" % (tag, remote.owner, remote.repo))
        print("  git tag %s %s" % (tag, commit[:12]))
        print("  git %s" % " ".join(push_command(origin, commit, tag)))
        print("  create the release as a draft%s, upload the files, then %s" % (
            " (pre-release)" if prerelease else "",
            "leave it as a draft" if draft else "publish it",
        ))
        return

    client = ForgejoClient(settings.base_url, settings.token, remote.owner, remote.repo)
    try:
        problem = repository_push_problem(client.repository())
        if problem:
            fail(problem)
        if client.release_by_tag(tag) is not None:
            fail("Forgejo already has a release %s; a release is never overwritten" % tag)
    except ForgejoError as error:
        fail(str(error))
    if remote_tag_exists(origin, tag):
        fail("Forgejo already has the tag %s; a release is never overwritten" % tag)

    git("tag", tag, commit)
    push(
        origin,
        commit,
        tag,
        "Forgejo",
        "\nThe push is atomic, so nothing reached Forgejo. Delete the local tag with `git tag -d %s` "
        "before trying again." % tag,
    )
    created = None
    try:
        created = client.create_release(release_request_body(tag, release_title(rel.full), notes, prerelease, commit))
        release_id = created.get("id") if isinstance(created, dict) else None
        if not isinstance(release_id, int) or isinstance(release_id, bool):
            raise ForgejoError("Forgejo created the release but returned no id")
        for asset in files:
            print("Uploading %s ..." % asset.name)
            client.upload_asset(release_id, asset.name, asset.data)
        if not draft:
            created = client.publish_release(release_id)
    except ForgejoError as error:
        state = "The tag %s is pushed" % tag
        if isinstance(created, dict) and created.get("id") is not None:
            state += " and draft release %s exists" % created.get("id")
        fail("%s. %s; finish or delete it in Forgejo before trying again." % (error, state))
    print()
    print("Forgejo release %s %s: %s" % (
        tag,
        "saved as a draft" if draft else ("published as a pre-release" if prerelease else "published"),
        created.get("html_url", "") if isinstance(created, dict) else "",
    ))
    print("After the go for GitHub:")
    print("  " + github_publish_hint(rel.base, signed, prerelease))


def github_publish_hint(base, signed, prerelease):
    """The command for the GitHub step with the same flags as the Forgejo step, so a pre-release
    stays a pre-release there and is never marked as the latest release."""
    return "py -3 tools/release.py --publish github --release %s%s%s" % (
        base,
        " --prerelease" if prerelease else "",
        "" if signed else " --allow-unsigned",
    )


def github_release_commands(gh, tag, repo, files, title, notes_file, prerelease, draft):
    """The gh commands that publish the built files, as argv lists (never a shell string).

    Draft first and published last, so /releases/latest never shows a release whose files are
    still missing. --verify-tag: the tag is pushed beforehand and gh must not create another.
    """
    create = [
        gh, "release", "create", tag, *[str(path) for path in files],
        "--repo", repo,
        "--verify-tag",
        "--title", title,
        "--notes-file", str(notes_file),
        "--draft",
    ]
    if prerelease:
        create.append("--prerelease")
    commands = [create]
    if not draft:
        edit = [gh, "release", "edit", tag, "--repo", repo, "--draft=false"]
        if not prerelease:
            edit.append("--latest")
        commands.append(edit)
    return commands


def quoted(argv):
    """Readable form of an argv list for printing only."""
    return " ".join('"%s"' % arg if (" " in arg or not arg) else arg for arg in argv)


def gh_run(argv, allowed=(0,)):
    result = subprocess.run(
        argv,
        cwd=ROOT,
        env=without_secrets(os.environ, keep=("GH_TOKEN", "GITHUB_TOKEN")),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode not in allowed:
        fail("gh %s failed: %s" % (" ".join(argv[1:3]), result.stderr.strip()))
    return result


def publish_github(rel, prerelease, draft, allow_unsigned, dry_run):
    files = checked_files(rel)
    signed = signed_and_unchanged(rel, files, allow_unsigned)
    notes = release_notes(released_entry(rel.base), signed)
    tag = tag_name(rel.base)
    commit = local_tag_commit(tag)
    if commit is None:
        fail("tag %s is missing; publish on Forgejo first (--publish forgejo)" % tag)
    problem = build_commit_problem(rel, git("rev-parse", commit + "^1"))
    if problem:
        fail(problem)
    try:
        tagged = json.loads(git("show", "%s:src-tauri/tauri.conf.json" % tag)).get("version")
    except ValueError:
        tagged = None
    if tagged != rel.full:
        fail("tag %s carries version %s, not the built %s" % (tag, tagged, rel.full))

    urls = [line for line in git("remote", "get-url", "--push", "--all", "github").splitlines() if line.strip()]
    if len(urls) != 1:
        fail("the remote github must have exactly one push URL, found: %d" % len(urls))
    try:
        remote = parse_remote_url(urls[0])
    except ValueError as error:
        fail("github: %s" % error)
    if remote.host != GITHUB_HOST:
        fail("the push URL of the remote github does not point at %s" % GITHUB_HOST)
    repo = "%s/%s" % (remote.owner, remote.repo)
    check_push_config(GITHUB_HOST, urls[0])
    gh = resolve_tool("gh")
    notes_file = rel.target / NOTES_NAME
    paths = [rel.target / asset.name for asset in files]
    commands = github_release_commands(gh, tag, repo, paths, release_title(rel.full), notes_file, prerelease, draft)

    print("Release %s from %s to %s, files:" % (release_title(rel.full), commit[:12], repo))
    for asset in files:
        print("  %s" % asset.name)
    if dry_run:
        print("Dry run, nothing changed. Publishing would:")
        print("  check that %s exists neither on GitHub nor as a release there" % tag)
        print("  git %s" % " ".join(push_command(urls[0], commit, tag)))
        for argv in commands:
            print("  %s" % quoted(argv))
        return

    if remote_tag_exists(urls[0], tag):
        fail("GitHub already has the tag %s; a release is never overwritten" % tag)
    view = gh_run([gh, "release", "view", tag, "--repo", repo, "--json", "tagName"], allowed=(0, 1))
    if view.returncode == 0:
        fail("GitHub already has a release %s; a release is never overwritten" % tag)
    if "not found" not in view.stderr.lower():
        fail("gh release view failed: %s" % view.stderr.strip())

    push(urls[0], commit, tag, "GitHub")
    notes_file.write_bytes((notes + "\n").encode("utf-8"))
    # gh reads the files from disk itself, so their hashes are checked right before and after.
    recheck(rel, files, "before gh read it")
    gh_run(commands[0])
    recheck(rel, files, "while gh uploaded it; delete the draft release on GitHub")
    for argv in commands[1:]:
        gh_run(argv)
    print()
    print("GitHub release %s %s." % (tag, "saved as a draft" if draft else "published"))


# ---------------------------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Build and publish a Hangar Note release")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--version", metavar="X.Y.Z", help="date the changelog, set X.Y.Z+B and build")
    mode.add_argument("--publish", choices=("forgejo", "github"), help="upload the built release")
    mode.add_argument("--next", metavar="X.Y.Z", help="after a release: start the upcoming version")
    parser.add_argument("--release", metavar="X.Y.Z", help="with --publish: the built release to upload")
    parser.add_argument("--prerelease", action="store_true", help="with --publish: mark it as a pre-release")
    parser.add_argument("--draft", action="store_true", help="with --publish: leave the release as a draft")
    parser.add_argument(
        "--allow-unsigned", action="store_true", help="build or publish without Authenticode (prints a warning)"
    )
    parser.add_argument("--dry-run", action="store_true", help="only show what would happen")
    args = parser.parse_args()
    # Windows would otherwise search the working folder for programs before PATH, also in every
    # child process.
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"

    if args.publish is None and (args.release or args.prerelease or args.draft):
        fail("--release, --prerelease and --draft work only with --publish")
    if args.next is not None:
        if args.allow_unsigned:
            fail("--allow-unsigned does not apply to --next")
        prepare_next(args.next, args.dry_run)
    elif args.version is not None:
        release(args.version, args.allow_unsigned, args.dry_run)
    else:
        rel = resolve_release(args.release)
        publish = publish_forgejo if args.publish == "forgejo" else publish_github
        publish(rel, args.prerelease, args.draft, args.allow_unsigned, args.dry_run)


if __name__ == "__main__":
    main()
