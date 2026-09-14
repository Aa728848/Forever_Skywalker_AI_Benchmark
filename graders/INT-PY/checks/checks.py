import json
import math
import pathlib
import random
import re
import sys
import tempfile
import threading
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "public-tests"))
from support import fine, ppt, response, transport, batch, CRITERIA, run


def alias_distribution_and_last_tag():
    text, tokens, probabilities = response(.5, .5)
    probabilities[1] = [("A", math.log(.3)), ("a", math.log(.2)), (">A", math.log(.1)), ("T", math.log(.7))]
    assert abs(fine.extract_score(text, tokens, probabilities, "<score_A>") - .3) < 1e-12
    assert fine.extract_score("<score_A>T</score_A>analysis<score_A>A</score_A>", None, None, "<score_A>") == 1


def directional_cache_hit_never_creates_client():
    with tempfile.TemporaryDirectory(prefix="fsa-python-hit-") as directory:
        cache = str(pathlib.Path(directory) / "cache.json")
        data = {fine.cache_key("correct", "task", 0, 1, 0): {"score_A": 1, "score_B": 0},
                fine.cache_key("correct", "task", 1, 0, 0): {"score_A": 0, "score_B": 1}}
        pathlib.Path(cache).write_text(json.dumps(data))
        previous = fine.create_client
        def forbidden():
            raise AssertionError("cached run tried to access credentials")
        fine.create_client = forbidden
        try:
            actual = batch([(0, 1), (1, 0)], cache=cache, client=fine.LazyClient())
        finally:
            fine.create_client = previous
        assert actual == data


def real_thread_pool_is_bounded_and_overlaps():
    barrier = threading.Barrier(2, timeout=3)
    lock = threading.Lock()
    active = peak = 0
    threads = set()
    def port(*args, **kwargs):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            threads.add(threading.get_ident())
        try:
            barrier.wait()
            return response(.8, .2)
        finally:
            with lock:
                active -= 1
    with transport(port):
        scores = batch([(0, 1), (1, 0)], workers=2)
    assert len(scores) == 2
    assert peak == 2 and len(threads) == 2 and active == 0, (peak, threads, active)


def source_pipeline_is_seeded_cached_and_linear_in_pivots():
    calls = []
    def port(client, prompt, *args, **kwargs):
        a = int(prompt.split("**Trajectory A:**")[1].split("candidate-")[1].splitlines()[0])
        b = int(prompt.split("**Trajectory B:**")[1].split("candidate-")[1].splitlines()[0])
        calls.append((a, b))
        return response(float(a == 2), float(b == 2))
    with tempfile.TemporaryDirectory(prefix="fsa-python-ppt-") as directory:
        cache = str(pathlib.Path(directory) / "cache.json")
        ring = ppt.ring_cycle(6, random.Random(20260914))
        assert ring == ppt.ring_cycle(6, random.Random(20260914))
        def score(a, b):
            scores = batch([(a, b)], cache=cache, reps=2)
            return fine.directed_reward(scores, "task", a, b, ["correct"], 2)
        with transport(port):
            first = ppt.select_best(6, ring, 2, score)
            count = len(calls)
            second = ppt.select_best(6, ring, 2, score)
        assert first == second == (2, 15), (first, second)
        assert count <= 2 * 15 and len(calls) == count
        assert all(0 <= v["score_A"] <= 1 and 0 <= v["score_B"] <= 1 for v in json.loads(pathlib.Path(cache).read_text()).values())


def raised_worker_error_preserves_failure():
    fault = RuntimeError("backend failed")
    def port(*args, **kwargs):
        raise fault
    with transport(port):
        try:
            batch([(0, 1)], on_error="raise")
        except RuntimeError as error:
            assert error is fault
        else:
            raise AssertionError("worker failure swallowed")
    with tempfile.TemporaryDirectory(prefix="fsa-python-invalid-cache-") as directory:
        cache = pathlib.Path(directory) / "cache.json"
        cache.write_text("not json")
        try:
            batch([(0, 1)], cache=str(cache))
        except json.JSONDecodeError:
            pass
        else:
            raise AssertionError("invalid cache was silently replaced")


if __name__ == "__main__":
    run([
        ("hidden/scalar-alias-and-final-tag-semantics", alias_distribution_and_last_tag),
        ("hidden/directional-cache-hit-without-credentials", directional_cache_hit_never_creates_client),
        ("hidden/real-thread-pool-bound-and-overlap", real_thread_pool_is_bounded_and_overlaps),
        ("hidden/source-pipeline-seeded-replay-and-cost", source_pipeline_is_seeded_cached_and_linear_in_pivots),
        ("hidden/worker-error-and-corrupt-cache-policy", raised_worker_error_preserves_failure),
    ])
