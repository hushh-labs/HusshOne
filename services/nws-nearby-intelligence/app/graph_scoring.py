from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from math import exp, log, log1p
from typing import Iterable, Mapping


@dataclass(frozen=True)
class GraphEdge:
    source: str
    target: str
    relation: str
    base_weight: float
    source_confidence: float = 1.0
    age_days: int = 0
    half_life_days: int = 730

    def effective_weight(self) -> float:
        if self.base_weight < 0:
            raise ValueError("base_weight cannot be negative")
        if not 0 <= self.source_confidence <= 1:
            raise ValueError("source_confidence must be in [0, 1]")
        if self.age_days < 0 or self.half_life_days <= 0:
            raise ValueError("invalid age or half life")
        freshness = exp(-log(2) * self.age_days / self.half_life_days)
        return self.base_weight * self.source_confidence * freshness


@dataclass(frozen=True)
class GraphPersonSignals:
    pagerank_percentile: float
    kcore_percentile: float
    bridging_percentile: float
    cross_sector_percentile: float


def _percentiles(values: Mapping[str, float]) -> dict[str, float]:
    if not values:
        return {}
    ordered = sorted(values.items(), key=lambda item: (item[1], item[0]))
    result: dict[str, float] = {}
    total = len(ordered)
    index = 0
    while index < total:
        end = index + 1
        while end < total and ordered[end][1] == ordered[index][1]:
            end += 1
        percentile = ((index + end - 1) / 2 + 0.5) / total
        for key, _ in ordered[index:end]:
            result[key] = percentile
        index = end
    return result


def weighted_pagerank(
    edges: Iterable[GraphEdge],
    *,
    damping: float = 0.85,
    max_iterations: int = 100,
    tolerance: float = 1e-10,
) -> dict[str, float]:
    edge_list = list(edges)
    nodes = sorted({edge.source for edge in edge_list} | {edge.target for edge in edge_list})
    if not nodes:
        return {}
    if not 0 < damping < 1:
        raise ValueError("damping must be in (0, 1)")

    outgoing: dict[str, list[tuple[str, float]]] = defaultdict(list)
    outgoing_total: dict[str, float] = defaultdict(float)
    for edge in edge_list:
        weight = edge.effective_weight()
        if weight <= 0:
            continue
        outgoing[edge.source].append((edge.target, weight))
        outgoing_total[edge.source] += weight

    count = len(nodes)
    ranks = {node: 1.0 / count for node in nodes}
    teleport = (1.0 - damping) / count
    for _ in range(max_iterations):
        next_ranks = {node: teleport for node in nodes}
        dangling_mass = sum(ranks[node] for node in nodes if outgoing_total[node] == 0)
        dangling_share = damping * dangling_mass / count
        for node in nodes:
            next_ranks[node] += dangling_share
        for source in nodes:
            total = outgoing_total[source]
            if total <= 0:
                continue
            contribution = damping * ranks[source]
            for target, weight in outgoing[source]:
                next_ranks[target] += contribution * weight / total
        delta = sum(abs(next_ranks[node] - ranks[node]) for node in nodes)
        ranks = next_ranks
        if delta <= tolerance:
            break
    normalization = sum(ranks.values()) or 1.0
    return {node: value / normalization for node, value in ranks.items()}


def kcore_numbers(edges: Iterable[GraphEdge]) -> dict[str, int]:
    adjacency: dict[str, set[str]] = defaultdict(set)
    for edge in edges:
        if edge.effective_weight() <= 0:
            continue
        adjacency[edge.source].add(edge.target)
        adjacency[edge.target].add(edge.source)
    nodes = set(adjacency)
    if not nodes:
        return {}

    degree = {node: len(adjacency[node]) for node in nodes}
    remaining = set(nodes)
    core = {node: 0 for node in nodes}
    current_k = 0
    while remaining:
        removable = deque(node for node in remaining if degree[node] <= current_k)
        if not removable:
            current_k = min(degree[node] for node in remaining)
            removable.extend(node for node in remaining if degree[node] <= current_k)
        while removable:
            node = removable.popleft()
            if node not in remaining:
                continue
            remaining.remove(node)
            core[node] = current_k
            for neighbor in adjacency[node]:
                if neighbor in remaining:
                    degree[neighbor] -= 1
                    if degree[neighbor] <= current_k:
                        removable.append(neighbor)
    return core


def bridging_scores(
    edges: Iterable[GraphEdge],
    *,
    community_by_node: Mapping[str, str],
) -> dict[str, float]:
    neighbors: dict[str, set[str]] = defaultdict(set)
    for edge in edges:
        if edge.effective_weight() <= 0:
            continue
        neighbors[edge.source].add(edge.target)
        neighbors[edge.target].add(edge.source)

    result: dict[str, float] = {}
    for node, node_neighbors in neighbors.items():
        counts: dict[str, int] = defaultdict(int)
        for neighbor in node_neighbors:
            counts[community_by_node.get(neighbor, "UNKNOWN")] += 1
        if len(counts) <= 1:
            entropy = 0.0
        else:
            total = sum(counts.values())
            raw_entropy = -sum((count / total) * log(count / total) for count in counts.values())
            entropy = raw_entropy / log(len(counts))
        degree_factor = min(1.0, log1p(len(node_neighbors)) / log1p(12))
        result[node] = entropy * degree_factor
    return result


def cross_sector_scores(
    edges: Iterable[GraphEdge],
    *,
    sector_by_node: Mapping[str, str],
    person_ids: set[str],
) -> dict[str, float]:
    sectors: dict[str, set[str]] = defaultdict(set)
    for edge in edges:
        if edge.source in person_ids and edge.target in sector_by_node:
            sectors[edge.source].add(sector_by_node[edge.target])
        if edge.target in person_ids and edge.source in sector_by_node:
            sectors[edge.target].add(sector_by_node[edge.source])
    return {person_id: min(1.0, log1p(len(sectors[person_id])) / log1p(6)) for person_id in person_ids}


def build_graph_person_signals(
    edges: Iterable[GraphEdge],
    *,
    person_ids: set[str],
    community_by_node: Mapping[str, str],
    sector_by_node: Mapping[str, str],
) -> dict[str, GraphPersonSignals]:
    edge_list = list(edges)
    pagerank = weighted_pagerank(edge_list)
    core = kcore_numbers(edge_list)
    bridging = bridging_scores(edge_list, community_by_node=community_by_node)
    sectors = cross_sector_scores(edge_list, sector_by_node=sector_by_node, person_ids=person_ids)

    pagerank_pct = _percentiles({person: pagerank.get(person, 0.0) for person in person_ids})
    core_pct = _percentiles({person: float(core.get(person, 0)) for person in person_ids})
    bridging_pct = _percentiles({person: bridging.get(person, 0.0) for person in person_ids})
    sector_pct = _percentiles({person: sectors.get(person, 0.0) for person in person_ids})

    return {
        person: GraphPersonSignals(
            pagerank_percentile=pagerank_pct[person],
            kcore_percentile=core_pct[person],
            bridging_percentile=bridging_pct[person],
            cross_sector_percentile=sector_pct[person],
        )
        for person in sorted(person_ids)
    }
