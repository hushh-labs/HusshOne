from app.entity_resolution import MatchDisposition, PublicPersonRecord, resolve_public_person


def test_name_only_does_not_match() -> None:
    left = PublicPersonRecord(record_id="l", name="Alex Smith")
    right = PublicPersonRecord(record_id="r", name="Alex Smith")
    assert resolve_public_person(left, right).disposition is MatchDisposition.NO_MATCH


def test_cik_and_name_match() -> None:
    left = PublicPersonRecord(
        record_id="l",
        name="Alex J. Smith",
        cik="12345",
        organization="Example Holdings",
        role="Chief Executive Officer",
    )
    right = PublicPersonRecord(
        record_id="r",
        name="Alex Smith",
        cik="0000012345",
        organization="Example Holdings Inc",
        role="CEO",
    )
    result = resolve_public_person(left, right)
    assert result.disposition is MatchDisposition.MATCH
