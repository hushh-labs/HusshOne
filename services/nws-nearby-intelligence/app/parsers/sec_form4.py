from __future__ import annotations

from xml.etree import ElementTree

from app.collectors.contracts import ArtifactManifest, ParsedObservation
from app.parsers.contracts import deterministic_observation_id


def _text(element: ElementTree.Element, path: str) -> str | None:
    node = element.find(path)
    if node is None or node.text is None:
        return None
    value = node.text.strip()
    return value or None


def _value(element: ElementTree.Element, field: str) -> str | None:
    return _text(element, f".//{{*}}{field}/{{*}}value")


def _flag(value: str | None) -> bool:
    return (value or "").strip().casefold() in {"1", "true", "yes", "y"}


class SecForm4Parser:
    parser_id = "sec-form4-xml"
    parser_version = "sec-form4-xml-v1.0.0"
    supported_source_ids = frozenset({"sec_edgar_ownership"})

    def parse(self, content: bytes, manifest: ArtifactManifest) -> list[ParsedObservation]:
        root = ElementTree.fromstring(content)
        issuer_cik = _text(root, ".//{*}issuerCik") or "unknown-issuer"
        issuer_name = _text(root, ".//{*}issuerName")
        owner_cik = _text(root, ".//{*}rptOwnerCik") or "unknown-owner"
        owner_name = _text(root, ".//{*}rptOwnerName")
        subject_id = f"sec-cik/{owner_cik}"
        object_id = f"sec-cik/{issuer_cik}"
        observations: list[ParsedObservation] = []

        relationship = root.find(".//{*}reportingOwnerRelationship")
        relationship_attributes: dict[str, object] = {
            "owner_name": owner_name,
            "issuer_name": issuer_name,
            "is_director": _flag(_text(relationship, ".//{*}isDirector")) if relationship is not None else False,
            "is_officer": _flag(_text(relationship, ".//{*}isOfficer")) if relationship is not None else False,
            "is_ten_percent_owner": _flag(_text(relationship, ".//{*}isTenPercentOwner")) if relationship is not None else False,
            "officer_title": _text(relationship, ".//{*}officerTitle") if relationship is not None else None,
        }
        observations.append(
            self._observation(
                manifest=manifest,
                fact_type="issuer_relationship",
                subject_external_id=subject_id,
                object_external_id=object_id,
                confidence=0.98,
                occurred_on=_text(root, ".//{*}periodOfReport"),
                attributes=relationship_attributes,
            )
        )
        if relationship_attributes["is_director"]:
            observations.append(
                self._observation(
                    manifest=manifest,
                    fact_type="director_role",
                    subject_external_id=subject_id,
                    object_external_id=object_id,
                    confidence=0.98,
                    occurred_on=_text(root, ".//{*}periodOfReport"),
                    attributes={"issuer_name": issuer_name},
                )
            )
        if relationship_attributes["is_officer"]:
            observations.append(
                self._observation(
                    manifest=manifest,
                    fact_type="public_role",
                    subject_external_id=subject_id,
                    object_external_id=object_id,
                    confidence=0.98,
                    occurred_on=_text(root, ".//{*}periodOfReport"),
                    attributes={
                        "issuer_name": issuer_name,
                        "title": relationship_attributes["officer_title"],
                    },
                )
            )

        transaction_index = 0
        for transaction in root.findall(".//{*}nonDerivativeTransaction"):
            transaction_index += 1
            attributes: dict[str, object] = {
                "security_title": _value(transaction, "securityTitle"),
                "transaction_code": _text(transaction, ".//{*}transactionCode"),
                "shares": _value(transaction, "transactionShares"),
                "price_per_share": _value(transaction, "transactionPricePerShare"),
                "acquired_or_disposed": _value(transaction, "transactionAcquiredDisposedCode"),
                "post_transaction_shares": _value(
                    transaction, "sharesOwnedFollowingTransaction"
                ),
                "direct_or_indirect": _value(transaction, "directOrIndirectOwnership"),
                "nature_of_ownership": _value(transaction, "natureOfOwnership"),
                "transaction_index": transaction_index,
            }
            observations.append(
                self._observation(
                    manifest=manifest,
                    fact_type="beneficial_ownership",
                    subject_external_id=subject_id,
                    object_external_id=object_id,
                    confidence=0.98,
                    occurred_on=_value(transaction, "transactionDate"),
                    attributes=attributes,
                )
            )
        return observations

    def _observation(
        self,
        *,
        manifest: ArtifactManifest,
        fact_type: str,
        subject_external_id: str,
        object_external_id: str | None,
        confidence: float,
        occurred_on: str | None,
        attributes: dict[str, object],
    ) -> ParsedObservation:
        return ParsedObservation(
            observation_id=deterministic_observation_id(
                source_id=manifest.source_id,
                artifact_sha256=manifest.sha256,
                fact_type=fact_type,
                subject_external_id=subject_external_id,
                object_external_id=object_external_id,
                attributes=attributes,
            ),
            source_id=manifest.source_id,
            artifact_sha256=manifest.sha256,
            parser_version=self.parser_version,
            fact_type=fact_type,
            subject_external_id=subject_external_id,
            object_external_id=object_external_id,
            confidence=confidence,
            occurred_on=occurred_on,
            attributes=attributes,
        )
