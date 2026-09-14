"""Transport-only fixture; all numerical and thread-pool logic is upstream code."""
import importlib.util
import math
import pathlib
import sys
from contextlib import contextmanager

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "starter" / "llm_verifier" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fine = load("fine_grained_reward")
ppt = load("pivot_tournament")
CRITERIA = [{"id": "correct", "name": "Correctness", "description": "Synthetic correctness"}]
TASKS = {"task": [{"problem": "synthetic task", "trace": "candidate-%d" % index} for index in range(6)]}


class FixedClient:
    def __init__(self):
        self.calls = 0

    def get(self):
        self.calls += 1
        return object()


def response(pa, pb):
    def distribution(p):
        return [("A", math.log(p) if p else -math.inf), ("T", math.log(1 - p) if p < 1 else -math.inf)]
    tokens = ["<score_A>", "A", "</score_A>", "<score_B>", "T", "</score_B>"]
    probabilities = [[("<score_A>", 0)], distribution(pa), [("</score_A>", 0)],
                     [("<score_B>", 0)], distribution(pb), [("</score_B>", 0)]]
    return "".join(tokens), tokens, probabilities


@contextmanager
def transport(port):
    previous = fine.call_verifier
    fine.call_verifier = port
    try:
        yield
    finally:
        fine.call_verifier = previous


def batch(pairs, cache=None, reps=1, criteria=None, client=None, on_error="tie", workers=2):
    return fine.score_directed_pairs(
        client or FixedClient(), TASKS, {"task": pairs}, criteria or CRITERIA,
        "Local synthetic transport only", reps, workers, cache,
        model="offline-fixture", progress=False, on_error=on_error)


def run(checks):
    print("# Python %s; RNG=random.Random; source=8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770" % sys.version.split()[0])
    failures = 0
    for number, (name, check) in enumerate(checks, 1):
        try:
            check()
            print("ok %d - %s" % (number, name))
        except Exception as error:
            failures += 1
            print("not ok %d - %s" % (number, name))
            print("  ---\n  error: %s: %s\n  ..." % (type(error).__name__, str(error).replace("\n", " ")))
    raise SystemExit(1 if failures else 0)
