import json
import math
import pathlib
import random
import tempfile

from support import fine, ppt, response, transport, batch, CRITERIA, run


def alias_probability_is_max_per_scalar():
    text, tokens, probabilities = response(.5, .5)
    probabilities[1] = [("A", math.log(.4)), (" a ", math.log(.2)), (">T", math.log(.4))]
    score = fine.extract_score(text, tokens, probabilities, "<score_A>")
    assert abs(score - .5) < 1e-12, score


def swapped_repetition_returns_candidate_order():
    with transport(lambda *args, **kwargs: response(.9, .1)):
        scores = batch([(0, 1)], reps=2)
    even = scores[fine.cache_key("correct", "task", 0, 1, 0)]
    odd = scores[fine.cache_key("correct", "task", 0, 1, 1)]
    assert abs(even["score_A"] - .9) < 1e-12
    assert abs(odd["score_A"] - .1) < 1e-12, odd
    assert fine.directed_reward(scores, "task", 0, 1, ["correct"], 2) == (.5, .5)


def tournament_tie_uses_lowest_index():
    ring = ppt.ring_cycle(5, random.Random(19))
    score = lambda a, b: fine.directed_reward({}, "task", a, b, ["correct"], 1)
    best, comparisons = ppt.select_best(5, ring, 2, score)
    assert best == 0, best
    assert comparisons == 5 + 2 * (5 - 2) + 1


def transient_failure_is_not_persisted():
    calls = []
    def failed(*args, **kwargs):
        calls.append(1)
        raise RuntimeError("temporary failure")
    with tempfile.TemporaryDirectory(prefix="fsa-python-cache-") as directory:
        cache = str(pathlib.Path(directory) / "cache.json")
        with transport(failed):
            scores = batch([(0, 1)], cache=cache)
            assert fine.directed_reward(scores, "task", 0, 1, [CRITERIA[0]["id"]], 1) == (.5, .5)
            assert json.loads(pathlib.Path(cache).read_text()) == {}
            batch([(0, 1)], cache=cache)
        assert len(calls) == 2


if __name__ == "__main__":
    run([
        ("public/scalar-alias-probability-dedup", alias_probability_is_max_per_scalar),
        ("public/odd-repetition-candidate-order", swapped_repetition_returns_candidate_order),
        ("public/tournament-tie-lowest-index", tournament_tie_uses_lowest_index),
        ("public/transient-tie-does-not-poison-cache", transient_failure_is_not_persisted),
    ])
