#!/usr/bin/env python3
"""
check-kit-ontology.py — mechanical checks from EXAMPLE-KIT.ttl's checklist.

    python3 check-kit-ontology.py path/to/yourkit.ttl

REFERENCE IMPLEMENTATION, version 1.0.0, current for kit-base 0.11.0.
This is an executable spec, not the product. It exists so the checklist in
EXAMPLE-KIT.ttl is testable today and so there is something unambiguous to port
into git-lex proper. Where this script and EXAMPLE-KIT.ttl disagree, the .ttl
wins — it is the standard; this only checks part of it.

Requires rdflib (pip install rdflib).

Exit 0 = clean or advisories only. Exit 1 = at least one ERROR.

NOT CHECKED HERE, because no parser can: whether a property passes the why-test,
whether a comment names the tempting wrong action, and whether Rob ruled on it.
Those stay human. This catches the mechanical half so review time goes to the
half that matters.
"""

import re
import sys

try:
    from rdflib import BNode, Graph, URIRef
    from rdflib.namespace import OWL, RDF, RDFS
except ImportError:
    sys.exit("needs rdflib:  pip install rdflib")

GITLEX = "https://repolex.ai/ontology/git-lex/"
THING = URIRef(GITLEX + "Thing")
FOLDERED = URIRef(GITLEX + "foldered")
GUIDANCE = URIRef(GITLEX + "authoringGuidance")

# An rdfs:comment is lifted verbatim into a document beside its key. Past this
# many characters it stops being a prompt and starts being a paragraph.
COMMENT_MAX = 160

errors: list[str] = []
advice: list[str] = []


def short(u) -> str:
    s = str(u)
    return s.rsplit("/", 1)[-1] if "/" in s else s


def deprecated(g, subject) -> bool:
    """A retired term is a tombstone, not a live declaration.

    Deprecated properties are deliberately minimal — `owl:deprecated true` plus a
    label, no domain/range/comment — because nothing authors them any more.
    Holding them to the live standard produced 94 errors on soul.ttl, every one
    of them wrong.
    """
    return any(str(v).lower() == "true" for v in g.objects(subject, OWL.deprecated))


def check(path: str) -> None:
    g = Graph()
    try:
        g.parse(path, format="turtle")
    except Exception as e:
        sys.exit(f"ERROR  does not parse: {e}")
    print(f"parses OK — {len(g)} triples\n")

    # --- the ontology header ------------------------------------------------
    onts = list(g.subjects(RDF.type, OWL.Ontology))
    if not onts:
        errors.append("no owl:Ontology header declared")
    for o in onts:
        if not list(g.objects(o, OWL.versionInfo)):
            errors.append(f"{short(o)}: no owl:versionInfo — bump it every change")
        if not list(g.objects(o, RDFS.comment)):
            advice.append(f"{short(o)}: ontology has no rdfs:comment")

    # --- classes ------------------------------------------------------------
    classes = set(g.subjects(RDF.type, OWL.Class))
    if not classes:
        advice.append("no owl:Class declared — is this a kit ontology?")

    for c in sorted(classes):
        # Blank nodes are anonymous class EXPRESSIONS (owl:Restriction,
        # owl:unionOf members). They are structure, not declared vocabulary, and
        # holding them to the label/comment standard flagged 20 phantom classes
        # in copia.
        if isinstance(c, BNode) or deprecated(g, c):
            continue
        name = short(c)
        if not list(g.objects(c, RDFS.label)):
            errors.append(f"class {name}: no rdfs:label")
        if not list(g.objects(c, RDFS.comment)):
            errors.append(f"class {name}: no rdfs:comment — one line saying what it is")

        is_foldered = any(
            str(v).lower() == "true" for v in g.objects(c, FOLDERED)
        )
        subclasses_thing = THING in set(g.objects(c, RDFS.subClassOf))

        if is_foldered:
            # The line people forget. Without it, none of the eight universal
            # properties apply to the class.
            if not subclasses_thing:
                errors.append(
                    f"class {name}: foldered but not rdfs:subClassOf git-lex:Thing"
                )
            # TWO IDENTITY STRATEGIES ARE LIVE, and a class needs exactly one.
            #   (a) convention anchor: a <class>Id property on the concrete class
            #   (b) the universal git-lex:id  (copia's newer classes, Rob-ruled
            #       2026-08-23 — the Thing plane already supplies an authored,
            #       rename-surviving id, so a <class>Id would be a second
            #       identity for the same node)
            # Neither is deprecated. Flagging (b) as missing (a) reported four
            # false errors against copia's newest and most correct classes.
            expected = name[0].lower() + name[1:] + "Id"
            ns = str(c).rsplit("/", 1)[0] + "/"
            has_class_id = (URIRef(ns + expected), None, None) in g
            # (b) is a per-document authoring choice, not a declaration, so the
            # ontology cannot prove it. Absence of (a) is therefore an advisory.
            if not has_class_id:
                advice.append(
                    f"class {name}: no {expected} declared. Fine if identity is "
                    f"the universal git-lex:id — say so in a comment so the next "
                    f"reader does not think it was forgotten."
                )
            if not list(g.objects(c, GUIDANCE)):
                advice.append(
                    f"class {name}: no git-lex:authoringGuidance — "
                    f"its body spec is the default placeholder"
                )

    # --- properties ---------------------------------------------------------
    props = set(g.subjects(RDF.type, OWL.DatatypeProperty)) | set(
        g.subjects(RDF.type, OWL.ObjectProperty)
    )
    for p in sorted(props):
        if isinstance(p, BNode) or deprecated(g, p):
            continue
        name = short(p)
        if not list(g.objects(p, RDFS.domain)):
            errors.append(f"property {name}: no rdfs:domain")
        if not list(g.objects(p, RDFS.label)):
            advice.append(f"property {name}: no rdfs:label")

        ranges = list(g.objects(p, RDFS.range))
        if not ranges:
            errors.append(f"property {name}: no rdfs:range")

        comments = list(g.objects(p, RDFS.comment))
        if not comments:
            errors.append(
                f"property {name}: no rdfs:comment — this is the text an author "
                f"reads while typing the value"
            )
        for cm in comments:
            if len(str(cm)) > COMMENT_MAX:
                advice.append(
                    f"property {name}: rdfs:comment is {len(str(cm))} chars — "
                    f"it lands after a long key; aim for one line"
                )

        # The reference-property lane check. A property named *Id whose range is
        # a concrete class takes BARE ids; if its comment shows the bracketed
        # form, the declaration and the instruction disagree and the value will
        # silently percent-encode.
        if name.endswith("Id") and ranges:
            r = ranges[0]
            concrete = r != THING and not str(r).startswith(
                "http://www.w3.org/2001/XMLSchema#"
            )
            # Match the ADDRESS SHAPE, not merely a "<". Comments legitimately
            # use angle brackets as placeholder notation ("Sam3Region:<descriptor>/<NN>"),
            # and a bare-substring test read those as addresses — one false
            # positive on copia:hasRegionId. Prefer a shape check to a character.
            says_brackets = any(
                re.search(r"<[a-z][\w-]*/[A-Z]\w*/", str(cm)) for cm in comments
            )
            if concrete and says_brackets:
                errors.append(
                    f"property {name}: range is {short(r)} (BARE-ID lane) but its "
                    f"comment shows a <bracketed> value. A bracketed value here "
                    f"does not error — it percent-encodes into the identifier. "
                    f"Use rdfs:range git-lex:Thing, or fix the comment."
                )
            if r == THING and comments and not says_brackets:
                advice.append(
                    f"property {name}: range is git-lex:Thing (address lane) but "
                    f"the comment does not show the <namespace/Class/id> form"
                )

    # --- report -------------------------------------------------------------
    for e in errors:
        print(f"ERROR   {e}")
    for a in advice:
        print(f"advice  {a}")

    if not errors and not advice:
        print("clean — mechanical checks pass.")
    print(
        f"\n{len(errors)} error(s), {len(advice)} advisory. "
        f"The why-test, comment register, and Rob's ruling are still yours."
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    check(sys.argv[1])
    sys.exit(1 if errors else 0)
