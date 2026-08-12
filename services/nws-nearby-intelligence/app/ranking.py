from __future__ import annotations

from collections.abc import Mapping

import numpy as np

from app.domain.models import RankSummary


def rank_from_samples(
    samples_by_subject: Mapping[str, np.ndarray],
    *,
    target_n: int = 514,
) -> list[RankSummary]:
    if not samples_by_subject:
        return []

    subject_ids = list(samples_by_subject)
    lengths = {len(samples_by_subject[subject_id]) for subject_id in subject_ids}
    if len(lengths) != 1:
        raise ValueError("all subjects must have the same simulation count")
    simulation_count = lengths.pop()
    if simulation_count == 0:
        raise ValueError("sample arrays cannot be empty")

    matrix = np.vstack([samples_by_subject[subject_id] for subject_id in subject_ids])
    # order[row-position, simulation] gives the original subject row at that rank.
    order = np.argsort(-matrix, axis=0, kind="stable")
    ranks = np.empty_like(order)
    simulation_columns = np.arange(simulation_count)
    for rank_index in range(len(subject_ids)):
        ranks[order[rank_index], simulation_columns] = rank_index + 1

    effective_target = min(target_n, len(subject_ids))
    results: list[RankSummary] = []
    for subject_index, subject_id in enumerate(subject_ids):
        subject_ranks = ranks[subject_index]
        results.append(
            RankSummary(
                subject_id=subject_id,
                median_rank=int(round(float(np.median(subject_ranks)))),
                rank_p05=int(np.quantile(subject_ranks, 0.05, method="nearest")),
                rank_p95=int(np.quantile(subject_ranks, 0.95, method="nearest")),
                probability_top_n=float(np.mean(subject_ranks <= effective_target)),
                target_n=target_n,
                simulation_count=simulation_count,
            )
        )
    return sorted(results, key=lambda result: (result.median_rank, -result.probability_top_n))
