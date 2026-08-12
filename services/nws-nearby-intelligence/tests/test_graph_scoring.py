from app.graph_scoring import GraphEdge, build_graph_person_signals, weighted_pagerank


def test_weighted_pagerank_is_normalized() -> None:
    edges = [
        GraphEdge("p1", "o1", "FOUNDED", 1.0),
        GraphEdge("p2", "o1", "EXECUTIVE", 0.8),
        GraphEdge("o1", "p1", "ROLE", 1.0),
    ]
    ranks = weighted_pagerank(edges)
    assert abs(sum(ranks.values()) - 1.0) < 1e-9
    assert set(ranks) == {"p1", "p2", "o1"}


def test_graph_signals_return_percentiles_for_people() -> None:
    edges = [
        GraphEdge("p1", "o1", "FOUNDED", 1.0),
        GraphEdge("o1", "p1", "ROLE", 1.0),
        GraphEdge("p1", "o2", "BOARD", 0.8),
        GraphEdge("o2", "p1", "ROLE", 0.8),
        GraphEdge("p2", "o1", "EXECUTIVE", 0.5),
        GraphEdge("o1", "p2", "ROLE", 0.5),
    ]
    signals = build_graph_person_signals(
        edges,
        person_ids={"p1", "p2"},
        community_by_node={"p1": "c1", "p2": "c1", "o1": "c1", "o2": "c2"},
        sector_by_node={"o1": "software", "o2": "health"},
    )
    assert signals["p1"].pagerank_percentile >= signals["p2"].pagerank_percentile
    assert 0 <= signals["p1"].bridging_percentile <= 1
