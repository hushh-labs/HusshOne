from __future__ import annotations

from app.collectors.contracts import ArtifactManifest, ParsedObservation
from app.parsers.contracts import ObservationParser


class ParserRegistry:
    def __init__(self, parsers: list[ObservationParser]) -> None:
        parser_ids = [parser.parser_id for parser in parsers]
        if len(set(parser_ids)) != len(parser_ids):
            raise ValueError("parser IDs must be unique")
        self._parsers = {parser.parser_id: parser for parser in parsers}
        self._by_source: dict[str, list[ObservationParser]] = {}
        for parser in parsers:
            for source_id in parser.supported_source_ids:
                self._by_source.setdefault(source_id, []).append(parser)

    def get(self, parser_id: str) -> ObservationParser:
        try:
            return self._parsers[parser_id]
        except KeyError as exc:
            raise KeyError(f"unknown parser {parser_id!r}") from exc

    def parsers_for_source(self, source_id: str) -> tuple[ObservationParser, ...]:
        return tuple(sorted(self._by_source.get(source_id, ()), key=lambda parser: parser.parser_id))

    def parse(
        self,
        *,
        parser_id: str,
        content: bytes,
        manifest: ArtifactManifest,
    ) -> list[ParsedObservation]:
        parser = self.get(parser_id)
        if manifest.source_id not in parser.supported_source_ids:
            raise ValueError(
                f"parser {parser_id!r} does not support source {manifest.source_id!r}"
            )
        return parser.parse(content, manifest)
