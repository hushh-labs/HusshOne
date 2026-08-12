from pathlib import Path
import sys

# Allow `python scripts/demo.py` from a fresh checkout without installing first.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from datetime import date

from app.affluence import select_top_anonymous_assets
from app.domain.models import AnonymousAssetFeatures
from app.ranking import rank_from_samples
from app.valuation import estimate_liability, estimate_public_equity, sample_net_worth, summarize_samples


alice_assets = [
    estimate_public_equity(
        component_id="alice-stock",
        subject_id="public-alice",
        shares=(900_000, 1_000_000, 1_050_000),
        price_usd=(90, 100, 115),
        liquidity_discount=(0.0, 0.02, 0.08),
        evidence_ids=("sec-4-alice", "market-eod"),
        quality_score=0.96,
        as_of_date=date(2026, 8, 11),
        double_count_group="issuer-A-common",
    ),
    estimate_liability(
        component_id="alice-debt",
        subject_id="public-alice",
        amount=(1_000_000, 3_000_000, 8_000_000),
        evidence_ids=("disclosed-debt-alice",),
        quality_score=0.75,
        as_of_date=date(2026, 8, 11),
    ),
]

bob_assets = [
    estimate_public_equity(
        component_id="bob-stock",
        subject_id="public-bob",
        shares=(1_200_000, 1_350_000, 1_500_000),
        price_usd=(65, 78, 92),
        evidence_ids=("sec-13g-bob", "market-eod"),
        quality_score=0.92,
        as_of_date=date(2026, 8, 11),
        double_count_group="issuer-B-common",
    )
]

samples = {}
for components in (alice_assets, bob_assets):
    subject_id, subject_samples = sample_net_worth(components, simulation_count=10_000)
    samples[subject_id] = subject_samples
    print(summarize_samples(subject_id, subject_samples))

print("\nRank uncertainty")
for row in rank_from_samples(samples, target_n=1):
    print(row)

print("\nAnonymous affluence")
anonymous_records = [
    AnonymousAssetFeatures(
        anonymous_id=f"KIR-98033-A{index:04d}",
        assessed_value=value,
        indexed_sale_value=value * 1.03,
        improvement_value=value * 0.55,
        lot_area_sqft=6_000 + index * 750,
        building_area_sqft=2_000 + index * 210,
        quality_index=5 + index / 10,
        waterfront_flag=index % 4 == 0,
        acs_income_context=160_000 + index * 5_000,
        acs_home_value_context=1_200_000 + index * 100_000,
        evidence_recency=0.9,
    )
    for index, value in enumerate([1_200_000, 1_800_000, 2_600_000, 4_000_000, 7_500_000], start=1)
]
for row in select_top_anonymous_assets(anonymous_records, count=3):
    print(row)
