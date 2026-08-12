from app.affluence import select_top_anonymous_assets
from app.domain.models import AnonymousAssetFeatures


def make_record(identifier: str, assessed: float, waterfront: bool = False) -> AnonymousAssetFeatures:
    return AnonymousAssetFeatures(
        anonymous_id=identifier,
        assessed_value=assessed,
        indexed_sale_value=assessed,
        improvement_value=assessed * 0.6,
        lot_area_sqft=10_000,
        building_area_sqft=3_000,
        quality_index=7,
        waterfront_flag=waterfront,
        acs_income_context=200_000,
        acs_home_value_context=1_500_000,
        evidence_recency=1.0,
    )


def test_top_count_and_order() -> None:
    records = [
        make_record("KIR-98033-A0001", 1_000_000),
        make_record("KIR-98033-A0002", 2_000_000),
        make_record("KIR-98033-A0003", 4_000_000, True),
    ]
    results = select_top_anonymous_assets(records, count=2)
    assert len(results) == 2
    assert results[0].anonymous_id == "KIR-98033-A0003"
    assert results[0].rank == 1
