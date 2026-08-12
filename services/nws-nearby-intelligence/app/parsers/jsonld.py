from __future__ import annotations

import json
from html.parser import HTMLParser
from typing import Iterable

from app.collectors.contracts import ArtifactManifest, ParsedObservation
from app.parsers.contracts import deterministic_observation_id


class _JsonLdScriptExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._capturing = False
        self._buffer: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() != "script":
            return
        attributes = {key.casefold(): (value or "") for key, value in attrs}
        script_type = attributes.get("type", "").split(";", 1)[0].strip().casefold()
        if script_type == "application/ld+json":
            self._capturing = True
            self._buffer = []

    def handle_data(self, data: str) -> None:
        if self._capturing:
            self._buffer.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "script" and self._capturing:
            self.scripts.append("".join(self._buffer).strip())
            self._capturing = False
            self._buffer = []


def _nodes(value: object) -> Iterable[dict[str, object]]:
    if isinstance(value, list):
        for item in value:
            yield from _nodes(item)
    elif isinstance(value, dict):
        graph = value.get("@graph")
        if graph is not None:
            yield from _nodes(graph)
        yield value


def _type_names(node: dict[str, object]) -> set[str]:
    value = node.get("@type")
    values = value if isinstance(value, list) else [value]
    return {str(item).casefold() for item in values if item}


def _external_id(node: dict[str, object], fallback_prefix: str) -> str:
    for field in ("@id", "url"):
        value = node.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    name = str(node.get("name") or "unknown").strip().casefold().replace(" ", "-")
    return f"{fallback_prefix}/{name}"


def _organization_name(value: object) -> str | None:
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        name = value.get("name")
        return str(name).strip() if name else None
    return None


class OfficialJsonLdParser:
    parser_id = "official-jsonld"
    parser_version = "official-jsonld-v1.0.0"
    supported_source_ids = frozenset(
        {
            "official_company_pages",
            "official_fund_and_portfolio_pages",
            "official_government_directories",
            "university_and_research_bios",
            "official_press_releases",
        }
    )

    def parse(self, content: bytes, manifest: ArtifactManifest) -> list[ParsedObservation]:
        extractor = _JsonLdScriptExtractor()
        extractor.feed(content.decode("utf-8", errors="replace"))
        observations: list[ParsedObservation] = []

        for raw_script in extractor.scripts:
            if not raw_script:
                continue
            try:
                payload = json.loads(raw_script)
            except json.JSONDecodeError:
                continue
            for node in _nodes(payload):
                types = _type_names(node)
                if "person" in types:
                    observations.extend(self._parse_person(node, manifest))
                if types & {"organization", "corporation", "governmentorganization", "collegeoruniversity"}:
                    observations.extend(self._parse_organization(node, manifest))
        return observations

    def _observation(
        self,
        *,
        manifest: ArtifactManifest,
        fact_type: str,
        subject_external_id: str,
        object_external_id: str | None,
        confidence: float,
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
            occurred_on=None,
            attributes=attributes,
        )

    def _parse_person(
        self,
        node: dict[str, object],
        manifest: ArtifactManifest,
    ) -> list[ParsedObservation]:
        person_id = _external_id(node, "jsonld/person")
        name = str(node.get("name") or "").strip()
        observations: list[ParsedObservation] = []
        if name:
            observations.append(
                self._observation(
                    manifest=manifest,
                    fact_type="identity_alias",
                    subject_external_id=person_id,
                    object_external_id=None,
                    confidence=0.82,
                    attributes={"display_name": name},
                )
            )

        job_title = str(node.get("jobTitle") or "").strip()
        works_for_value = node.get("worksFor") or node.get("affiliation")
        organization_name = _organization_name(works_for_value)
        organization_id = (
            _external_id(works_for_value, "jsonld/organization")
            if isinstance(works_for_value, dict)
            else None
        )
        if job_title or organization_name:
            observations.append(
                self._observation(
                    manifest=manifest,
                    fact_type="current_role",
                    subject_external_id=person_id,
                    object_external_id=organization_id,
                    confidence=0.80,
                    attributes={
                        "title": job_title or None,
                        "organization_name": organization_name,
                    },
                )
            )

        same_as = node.get("sameAs")
        links = same_as if isinstance(same_as, list) else [same_as]
        normalized_links = sorted(
            {str(link).strip() for link in links if isinstance(link, str) and link.strip()}
        )
        if normalized_links:
            observations.append(
                self._observation(
                    manifest=manifest,
                    fact_type="official_profile_link",
                    subject_external_id=person_id,
                    object_external_id=None,
                    confidence=0.78,
                    attributes={"same_as": normalized_links},
                )
            )
        # Person.address is intentionally ignored; it may represent a private residence.
        return observations

    def _parse_organization(
        self,
        node: dict[str, object],
        manifest: ArtifactManifest,
    ) -> list[ParsedObservation]:
        organization_id = _external_id(node, "jsonld/organization")
        name = str(node.get("name") or "").strip()
        observations: list[ParsedObservation] = []
        if name:
            observations.append(
                self._observation(
                    manifest=manifest,
                    fact_type="organization_identity",
                    subject_external_id=organization_id,
                    object_external_id=None,
                    confidence=0.82,
                    attributes={"legal_or_public_name": name, "url": node.get("url")},
                )
            )

        address = node.get("address")
        if isinstance(address, dict):
            city = str(address.get("addressLocality") or "").strip()
            region = str(address.get("addressRegion") or "").strip()
            country = str(address.get("addressCountry") or "").strip()
            if city or region:
                observations.append(
                    self._observation(
                        manifest=manifest,
                        fact_type="office_location",
                        subject_external_id=organization_id,
                        object_external_id=None,
                        confidence=0.76,
                        attributes={
                            "city": city or None,
                            "region": region or None,
                            "country": country or None,
                        },
                    )
                )
        return observations
