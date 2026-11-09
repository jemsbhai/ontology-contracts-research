/**
 * Versioned, deliberately limited unittest instrumentation. The original test module and consumer are not edited.
 * The runner, oracle and Python runtime remain trusted: audit hooks and transport interception are not a hostile-code
 * sandbox. Module identities cover observed module files on disk, not in-memory code or every native dependency.
 */
export const PYTHON_CONSUMER_ADAPTER = String.raw`
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sys
import traceback
import unittest
import urllib.error
import urllib.parse
import urllib.request
import urllib.response
from email.message import Message

SCHEMA = "erden.consumer-runner/v1"
MAX_LOG_BYTES = 1048576
MAX_EVENTS = 10000
MAX_RESOURCE_BYTES = 67108864
MAX_DETAIL_BYTES = 16384
MAX_TOTAL_DETAIL_BYTES = 4194304


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def file_digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1048576), b""):
            h.update(block)
    return h.hexdigest()


def closed(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError(label + " must have exactly the declared fields")
    return value


def text(value, label):
    if not isinstance(value, str) or not value or "\0" in value:
        raise ValueError(label + " must be a nonempty string")
    value.encode("utf-8", errors="strict")
    return value


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate runner-spec JSON key: " + key)
        value[key] = item
    return value


def strings(value, label, limit, nonempty=True):
    if not isinstance(value, list) or len(value) > limit or (nonempty and not value):
        raise ValueError(label + " must be a bounded list")
    for item in value:
        text(item, label)
    if len(set(value)) != len(value):
        raise ValueError(label + " contains duplicates")
    return value


def absolute(value, label):
    value = text(value, label)
    if not os.path.isabs(value):
        raise ValueError(label + " must be absolute")
    return Path(value).resolve()


def relative(root, value, label, allow_dot=False):
    value = text(value, label)
    if value != "." or not allow_dot:
        parts = value.split("/")
        if ("\\" in value or ":" in value or any(
            not part or part in (".", "..") or part[-1:] in (".", " ") or
            re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.I)
            for part in parts)):
            raise ValueError(label + " must be a safe relative POSIX path")
    result = (root / value).resolve()
    if not result.is_relative_to(root):
        raise ValueError(label + " leaves its declared root")
    return result


class BoundedText(io.StringIO):
    def __init__(self):
        super().__init__()
        self.byte_count = 0
        self.exceeded = False

    def write(self, value):
        original_length = len(value)
        encoded = value.encode("utf-8", errors="replace")
        available = max(0, MAX_LOG_BYTES - self.byte_count)
        self.byte_count += len(encoded)
        if len(encoded) > available:
            self.exceeded = True
            value = encoded[:available].decode("utf-8", errors="ignore")
        super().write(value)
        return original_length


def main():
    report = {
        "schema": "erden.consumer-runner-result/v1", "id": "invalid",
        "discoveredTests": [], "tests": [], "resourceEvents": [],
        "networkAttempts": [], "fatalError": None, "stdout": "", "stderr": "",
        "runtime": {"pythonVersion": sys.version, "executable": sys.executable,
                    "distributions": [], "moduleFiles": []},
    }
    stdout = BoundedText()
    stderr = BoundedText()
    policy_failures = []
    observed_cache = {}
    written_resources = set()
    audit_active = False
    detail_bytes = 0

    def fatal(message):
        report["fatalError"] = message if report["fatalError"] is None else report["fatalError"] + "\n" + message

    def event(value):
        if len(report["resourceEvents"]) >= MAX_EVENTS:
            if not policy_failures:
                policy_failures.append("Resource observation limit exceeded")
            raise RuntimeError("Resource observation limit exceeded")
        report["resourceEvents"].append(value)

    def denied(description):
        if len(report["networkAttempts"]) < MAX_EVENTS:
            report["networkAttempts"].append(description)
        if not policy_failures:
            policy_failures.append("Forbidden network or subprocess operation")
        raise PermissionError("Consumer instrumentation denied: " + description)

    try:
        if len(sys.argv) != 2:
            raise ValueError("Expected exactly one absolute runner-spec path")
        spec_path = absolute(sys.argv[1], "spec path")
        if spec_path.stat().st_size > 8388608:
            raise ValueError("Runner spec exceeds the byte bound")
        with open(spec_path, "r", encoding="utf-8") as stream:
            spec = json.load(stream, object_pairs_hook=unique_object)
        closed(spec, ["schema", "id", "sourceRoot", "testFile", "cwd", "testClasses",
                      "expectedTests", "cacheDir", "resources"], "runner input")
        if spec["schema"] != SCHEMA:
            raise ValueError("Unsupported runner schema")
        report["id"] = text(spec["id"], "id")
        source_root = absolute(spec["sourceRoot"], "sourceRoot")
        cache_dir = absolute(spec["cacheDir"], "cacheDir")
        if not source_root.is_dir() or not cache_dir.is_dir():
            raise ValueError("Source and cache roots must exist as directories")
        test_file = relative(source_root, spec["testFile"], "testFile")
        cwd = relative(source_root, spec["cwd"], "cwd", allow_dot=True)
        if not test_file.is_file() or not cwd.is_dir():
            raise ValueError("Declared test module or working directory is missing")
        classes = strings(spec["testClasses"], "testClasses", 128)
        expected = strings(spec["expectedTests"], "expectedTests", 4096)
        identifier = re.compile(r"^[A-Za-z_]\w*$", re.ASCII)
        if any(not identifier.fullmatch(name) for name in classes):
            raise ValueError("Invalid test class identifier")
        for name in expected:
            parts = name.split(".")
            if len(parts) != 2 or parts[0] not in classes or not all(identifier.fullmatch(p) for p in parts):
                raise ValueError("Invalid expected test identifier")
        if not isinstance(spec["resources"], list) or len(spec["resources"]) > 256:
            raise ValueError("Invalid resources")
        by_uri = {}
        resource_ids = set()
        total_resource_bytes = 0
        for resource in spec["resources"]:
            closed(resource, ["id", "uris", "cachePath", "sourcePath", "sha256"], "resource")
            rid = text(resource["id"], "resource id")
            if rid in resource_ids:
                raise ValueError("Duplicate resource identity")
            resource_ids.add(rid)
            uris = strings(resource["uris"], "resource URIs", 33)
            source_path = absolute(resource["sourcePath"], "resource sourcePath")
            expected_sha = resource["sha256"]
            if not isinstance(expected_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
                raise ValueError("Invalid resource SHA-256")
            total_resource_bytes += source_path.stat().st_size
            if total_resource_bytes > MAX_RESOURCE_BYTES:
                raise ValueError("Pinned resources exceed the aggregate byte bound")
            payload = source_path.read_bytes()
            if digest_bytes(payload) != expected_sha:
                raise ValueError("Pinned resource bytes do not match: " + rid)
            cache_path = relative(cache_dir, resource["cachePath"], "resource cachePath")
            key = os.path.normcase(str(cache_path))
            if key in observed_cache:
                raise ValueError("Resources alias the same cache path")
            media_type = {".jsonld": "application/ld+json", ".json": "application/json",
                ".ttl": "text/turtle", ".rdf": "application/rdf+xml", ".nt": "application/n-triples",
                ".txt": "text/plain", ".csv": "text/csv"}.get(source_path.suffix.lower(), "application/octet-stream")
            bound = {"id": rid, "bytes": payload, "sha256": expected_sha,
                     "cachePath": str(cache_path), "mediaType": media_type}
            observed_cache[key] = bound
            for uri in uris:
                parsed = urllib.parse.urlsplit(uri)
                if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
                    raise ValueError("Invalid HTTP resource URI")
                if uri in by_uri:
                    raise ValueError("Resources alias the same URI")
                by_uri[uri] = bound

        def response_bytes(url, method):
            if method != "GET" or url not in by_uri:
                # Undeclared URLs may carry credentials or query tokens; never copy those into diagnostics.
                try:
                    parsed = urllib.parse.urlsplit(url)
                    destination = urllib.parse.urlunsplit((parsed.scheme, parsed.hostname or "", parsed.path, "", ""))
                except ValueError:
                    destination = "<invalid URL>"
                denied("HTTP " + method + " " + destination)
            resource = by_uri[url]
            event({"kind": "http", "resourceId": resource["id"], "url": url,
                   "path": None, "sha256": resource["sha256"]})
            return resource

        class PinnedTransport(urllib.request.BaseHandler):
            handler_order = 100

            def http_open(self, request):
                resource = response_bytes(request.full_url, request.get_method())
                payload = resource["bytes"]
                headers = Message()
                headers["Content-Type"] = resource["mediaType"]
                headers["Content-Length"] = str(len(payload))
                response = urllib.response.addinfourl(io.BytesIO(payload), headers, request.full_url, 200)
                response.msg = "OK"
                return response

            https_open = http_open

        urllib.request.install_opener(urllib.request.build_opener(PinnedTransport()))
        # Import the optional transport dependency as adapter setup, before consumer imports.
        # These two transport implementations do not replace the consumer's context loader.
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                import requests
            except ImportError:
                requests = None
            if requests is not None:
                original_session_init = requests.sessions.Session.__init__
                def pinned_session_init(session, *args, **kwargs):
                    original_session_init(session, *args, **kwargs)
                    # Pinned offline transport must not consult ambient netrc/proxy settings.
                    # This is fixture configuration, not a sandbox or an application-loader change.
                    session.trust_env = False
                requests.sessions.Session.__init__ = pinned_session_init

                def pinned_send(session, request, **kwargs):
                    resource = response_bytes(request.url, request.method)
                    payload = resource["bytes"]
                    response = requests.Response()
                    response.status_code = 200
                    response.url = request.url
                    response.request = request
                    response.headers["Content-Type"] = resource["mediaType"]
                    response.headers["Content-Length"] = str(len(payload))
                    response.encoding = "utf-8"
                    response._content = payload
                    response._content_consumed = True
                    response.raw = io.BytesIO(payload)
                    return response
                requests.sessions.Session.send = pinned_send

        def cache_hash(path):
            nonlocal audit_active
            previous = audit_active
            audit_active = True
            try:
                return file_digest(path) if os.path.isfile(path) else None
            finally:
                audit_active = previous

        def audit(name, args):
            nonlocal audit_active
            if audit_active:
                return
            if name in ("socket.connect", "socket.getaddrinfo", "socket.bind", "socket.sendto", "socket.sendmsg"):
                # Audit argument layouts differ; a socket event must not expose payload bytes or credentials.
                denied(name)
            if name in ("subprocess.Popen", "_winapi.CreateProcess", "os.system", "os.posix_spawn", "os.spawn", "os.exec", "os.fork", "os.forkpty", "os.startfile", "os.startfile/2"):
                # Never serialize subprocess arguments/environment: they may contain credentials.
                denied(name)
            if name in ("os.rename", "os.remove", "os.truncate", "os.link", "os.symlink"):
                audit_active = True
                try:
                    for value in args[:2] if name in ("os.rename", "os.link", "os.symlink") else args[:1]:
                        if isinstance(value, (str, bytes, os.PathLike)):
                            resource = observed_cache.get(os.path.normcase(os.path.realpath(os.fsdecode(value))))
                            if resource is not None:
                                written_resources.add(resource["id"])
                finally:
                    audit_active = False
                return
            if name != "open" or not args or not isinstance(args[0], (str, bytes, os.PathLike)):
                return
            audit_active = True
            try:
                path = os.path.normcase(os.path.realpath(os.fsdecode(args[0])))
                resource = observed_cache.get(path)
                if resource is None:
                    return
                mode = args[1] if len(args) > 1 else None
                flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
                writes = (isinstance(mode, str) and any(c in mode for c in "wax+")) or bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
                reads = (isinstance(mode, str) and ("r" in mode or "+" in mode)) or not bool(flags & os.O_WRONLY)
                digest = cache_hash(path)
                if reads:
                    event({"kind": "cache-read", "resourceId": resource["id"], "url": None,
                           "path": resource["cachePath"], "sha256": digest})
                if writes:
                    written_resources.add(resource["id"])
            finally:
                audit_active = False

        sys.addaudithook(audit)
        # POSIX-oriented consumers sometimes prefix TMPDIR with file:// themselves.
        # A Windows drive-root-relative path works for both open() and file:/// URI loading.
        temporary = cache_dir.as_posix()
        if os.name == "nt":
            if not re.match(r"^[A-Za-z]:/", temporary) or source_root.drive.lower() != cache_dir.drive.lower():
                raise ValueError("Windows source/cache require the same ordinary drive for TMPDIR")
            temporary = temporary[2:]
        os.environ["TMPDIR"] = temporary
        os.environ["TMP"] = str(cache_dir)
        os.environ["TEMP"] = str(cache_dir)
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(source_root))
        os.chdir(cwd)

        records = {}
        started = []

        def test_id(test):
            parent = getattr(test, "test_case", None) or getattr(test, "_test_case", None)
            if parent is not None:
                return test_id(parent)
            method = getattr(test, "_testMethodName", None)
            if method is not None:
                return type(test).__name__ + "." + method
            return str(test.id())

        class Results(unittest.TextTestResult):
            def record(self, test, outcome, detail=None):
                nonlocal detail_bytes
                tid = test_id(test)
                item = records.setdefault(tid, {"id": tid, "outcome": "passed", "detail": None})
                ranks = {"passed": 0, "skipped": 1, "failed": 2, "error": 3}
                if ranks[outcome] > ranks[item["outcome"]]:
                    item["outcome"] = outcome
                if detail:
                    encoded = detail.encode("utf-8", errors="replace")
                    available = min(MAX_DETAIL_BYTES, max(0, MAX_TOTAL_DETAIL_BYTES - detail_bytes))
                    if len(encoded) > available:
                        if "Test detail bound exceeded" not in policy_failures:
                            policy_failures.append("Test detail bound exceeded")
                        detail = encoded[:available].decode("utf-8", errors="ignore")
                    detail_bytes += len(detail.encode("utf-8", errors="replace"))
                    item["detail"] = detail if item["detail"] is None else item["detail"] + "\n" + detail

            def startTest(self, test):
                started.append(test_id(test))
                super().startTest(test)

            def addSuccess(self, test):
                self.record(test, "passed")
                super().addSuccess(test)

            def addFailure(self, test, err):
                self.record(test, "failed", self._exc_info_to_string(err, test))
                super().addFailure(test, err)

            def addError(self, test, err):
                self.record(test, "error", self._exc_info_to_string(err, test))
                super().addError(test, err)

            def addSkip(self, test, reason):
                self.record(test, "skipped", "skip " + str(test) + ": " + str(reason))
                super().addSkip(test, reason)

            def addExpectedFailure(self, test, err):
                self.record(test, "skipped", "expected-failure: " + self._exc_info_to_string(err, test))
                super().addExpectedFailure(test, err)

            def addUnexpectedSuccess(self, test):
                self.record(test, "failed", "unexpected-success")
                super().addUnexpectedSuccess(test)

            def addSubTest(self, test, subtest, err):
                outcome = "passed" if err is None else "failed" if issubclass(err[0], test.failureException) else "error"
                detail = "subtest " + str(subtest) + ": " + outcome
                if err is not None:
                    detail += "\n" + self._exc_info_to_string(err, test)
                self.record(test, outcome, detail)
                super().addSubTest(test, subtest, err)

        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            module_spec = importlib.util.spec_from_file_location("erden_consumer_original_tests", test_file)
            if module_spec is None or module_spec.loader is None:
                raise ValueError("Could not load declared test module")
            module = importlib.util.module_from_spec(module_spec)
            sys.modules[module_spec.name] = module
            module_spec.loader.exec_module(module)
            loader = unittest.TestLoader()
            suite = unittest.TestSuite()
            discovered = []
            for name in classes:
                test_class = getattr(module, name, None)
                if not isinstance(test_class, type) or not issubclass(test_class, unittest.TestCase) or test_class.__name__ != name:
                    raise ValueError("Declared class is not an original unittest.TestCase: " + name)
                loaded = loader.loadTestsFromTestCase(test_class)
                tests = list(loaded)
                if not tests:
                    raise ValueError("Declared test class contains no tests: " + name)
                discovered.extend(test_id(test) for test in tests)
                suite.addTests(tests)
            report["discoveredTests"] = sorted(discovered)
            if len(set(discovered)) != len(discovered) or sorted(discovered) != sorted(expected):
                raise ValueError("Discovered original tests do not exactly match the declared inventory")
            try:
                unittest.TextTestRunner(stream=stderr, verbosity=2, resultclass=Results).run(suite)
            finally:
                report["tests"] = sorted(records.values(), key=lambda item: item["id"])
            if not started or len(set(started)) != len(started) or sorted(started) != sorted(expected) or sorted(records) != sorted(expected):
                raise ValueError("Original test execution did not cover every declared test exactly once")

    except BaseException:
        fatal(traceback.format_exc())
    finally:
        # Cache-open events hash bytes at the observation point, not a transactional read proof.
        # Final write observations bind the resulting declared cache cells after unittest finishes.
        audit_active = True
        try:
            for resource in observed_cache.values():
                if resource["id"] in written_resources:
                    path = resource["cachePath"]
                    event({"kind": "cache-write", "resourceId": resource["id"],
                        "url": None, "path": path, "sha256": file_digest(path) if os.path.isfile(path) else None})
            distributions = set()
            for distribution in importlib.metadata.distributions():
                name = distribution.metadata.get("Name")
                if name:
                    if len(name) > 1024 or len(distribution.version) > 1024 or len(distributions) >= MAX_EVENTS:
                        raise ValueError("Distribution observation bound exceeded")
                    distributions.add((name, distribution.version))
            report["runtime"]["distributions"] = [{"name": n, "version": v} for n, v in sorted(distributions)]
            module_files = set()
            for module in list(sys.modules.values()):
                path = getattr(module, "__file__", None)
                if isinstance(path, str):
                    resolved = os.path.realpath(path)
                    if len(resolved) > 4096 or len(module_files) >= MAX_EVENTS:
                        raise ValueError("Module observation bound exceeded")
                    if not os.path.isfile(resolved):
                        raise ValueError("Observed module file is unavailable: " + resolved)
                    module_files.add(resolved)
            report["runtime"]["moduleFiles"] = [{"path": path, "sha256": file_digest(path)} for path in sorted(module_files)]
        except BaseException:
            fatal("Runtime/cache observation failed:\n" + traceback.format_exc())
        audit_active = False
        if policy_failures:
            fatal("; ".join(policy_failures))
        if stdout.exceeded or stderr.exceeded:
            fatal("Captured test output exceeded the adapter's per-stream UTF-8 byte bound")
        report["stdout"] = stdout.getvalue()
        report["stderr"] = stderr.getvalue()
        sys.stdout.write(json.dumps(report, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
`;
