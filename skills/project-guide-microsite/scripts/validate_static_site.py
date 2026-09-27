#!/usr/bin/env python3
"""Validate a small static project guide site with standard-library checks."""

from __future__ import annotations

import argparse
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from typing import List, Optional, Tuple
from urllib.parse import unquote, urlparse


class LinkCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: List[str] = []
        self.has_theme_toggle: bool = False
        self.has_early_load: bool = False
        self.has_meta_description: bool = False
        self.has_og_image: bool = False
        self.has_favicon_link: bool = False
        self._in_head: int = 0

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        if tag == "a":
            for name, value in attrs:
                if name == "href" and value:
                    self.links.append(value)
        if tag == "meta":
            attr_dict = dict(attrs)
            name = (attr_dict.get("name") or "").strip().lower()
            # OpenGraph is property= based; accept name= as a tolerated variant.
            prop = (attr_dict.get("property") or attr_dict.get("name") or "").strip().lower()
            if name == "description":
                self.has_meta_description = True
            if prop == "og:image":
                self.has_og_image = True
        if tag == "link":
            attr_dict = dict(attrs)
            if "icon" in (attr_dict.get("rel") or "").strip().lower():
                self.has_favicon_link = True
        if tag == "head":
            self._in_head += 1
        if tag == "button":
            attr_dict = dict(attrs)
            if attr_dict.get("id") == "theme-toggle":
                self.has_theme_toggle = True

    def handle_data(self, data: str) -> None:
        if self._in_head > 0 and "localStorage" in data and "theme" in data:
            self.has_early_load = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "head":
            self._in_head = max(0, self._in_head - 1)


def should_skip_link(href: str) -> bool:
    parsed = urlparse(href)
    # netloc without scheme covers protocol-relative //host/path links: they
    # are external, and resolving them as paths yields phantom breakage.
    return bool(
        parsed.scheme in {"http", "https", "mailto", "file"}
        or parsed.netloc
        or href.startswith("#")
    )


def validate_html(path: Path, enforce_design_system: bool) -> List[str]:
    errors: List[str] = []
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [f"{path}: cannot read HTML file: {exc}"]

    parser = LinkCollector()
    try:
        parser.feed(text)
    except Exception as exc:
        errors.append(f"{path}: HTML parse failed: {exc}")

    lowered = text.lower()
    if "lorem ipsum" in lowered:
        errors.append(f"{path}: contains lorem ipsum placeholder text")

    # Check for unresolved markers, but skip verbatim content: <script> blocks,
    # and <pre>/<code> samples. A documented shell snippet legitimately contains
    # "}}" — that is what nested `${VAR:-}` parameter expansion ends with, and the
    # BrowserBay resolver one-liner these pages quote is required to ship in
    # exactly that form. Flagging it would push authors to escape real content in
    # order to satisfy the checker, which hides markers rather than resolving them.
    text_no_verbatim = re.sub(
        r"<(script|pre|code)\b[^>]*>.*?</\1>",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    for marker in ("{{", "}}", "TO" + "DO"):
        if marker in text_no_verbatim:
            errors.append(f"{path}: contains unresolved marker {marker!r}")

    # Design System v2 checks are opt-in so legacy generated sites remain valid.
    # Template detection uses the stripped text: a page whose only {{ lives in
    # a verbatim sample is a real page and must still pass design review, while
    # prose {{ already fails the unresolved-marker check above.
    if enforce_design_system and "{{" not in text_no_verbatim:
        if not parser.has_early_load:
            errors.append(f"{path}: missing early-load theme script in <head>")
        if not parser.has_theme_toggle:
            errors.append(f"{path}: missing theme toggle button")

    if enforce_design_system:
        hardcoded = re.findall(r'(?:background|color|border-color):\s*#[0-9a-fA-F]{3,8}', text)
        code_colors = {"#181825", "#cdd6f4", "#6c7086", "#a6e3a1", "#0e0e16"}
        problematic = [c for c in hardcoded if not any(cc in c for cc in code_colors)]
        if problematic:
            errors.append(f"{path}: hardcoded colors (use var() tokens): {', '.join(problematic[:3])}")

    if enforce_design_system and "{{" not in text_no_verbatim:
        # Required metadata must exist as parsed elements: a commented-out
        # tag or a substring mention in prose is not a meta tag.
        if not parser.has_meta_description:
            errors.append(f"{path}: missing meta description tag")
        if not parser.has_og_image:
            errors.append(f"{path}: missing og:image meta tag")
        if not parser.has_favicon_link:
            errors.append(f"{path}: missing favicon link tags")

    for href in parser.links:
        if should_skip_link(href):
            continue
        # Fragment and query belong to the URL, not the filesystem path; strip
        # both, then decode percent-encoding, before resolving the target.
        local = unquote(href.split("#", 1)[0].split("?", 1)[0])
        if href.endswith("/") or not local:
            continue
        target = (path.parent / local).resolve()
        if not target.exists():
            errors.append(f"{path}: broken relative link {href!r}")
    return errors


def main() -> int:
    argp = argparse.ArgumentParser(description=__doc__)
    argp.add_argument("site_dir", type=Path, help="Directory containing the static guide site")
    args = argp.parse_args()

    site_dir = args.site_dir.expanduser().resolve()
    errors: List[str] = []

    if not site_dir.is_dir():
        errors.append(f"{site_dir}: site directory does not exist")
    else:
        for required in ("index.html", "styles.css"):
            if not (site_dir / required).is_file():
                errors.append(f"{site_dir}: missing required file {required}")

        enforce_design_system = False
        css_path = site_dir / "styles.css"
        if css_path.is_file():
            css_text = css_path.read_text(encoding="utf-8")
            enforce_design_system = "Design System v2" in css_text
            if enforce_design_system and 'data-theme="dark"' not in css_text:
                errors.append(f"{css_path}: missing dark mode variables ([data-theme=\"dark\"])")

        if enforce_design_system:
            for required_asset in ("favicon.svg", "favicon.ico", "apple-touch-icon.png"):
                if not (site_dir / required_asset).is_file():
                    errors.append(f"{site_dir}: missing required asset {required_asset}")

        html_files = sorted(site_dir.rglob("*.html"))
        if not html_files:
            errors.append(f"{site_dir}: no HTML files found")
        for html_file in html_files:
            errors.extend(validate_html(html_file, enforce_design_system))

    if errors:
        for error in errors:
            sys.stdout.write(f"ERROR: {error}\n")
        return 1

    sys.stdout.write(f"html-ok: {site_dir}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
