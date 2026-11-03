# Glossary

Terms used by ts-axi, its output and its documentation. Implementation details do not belong here.

## Symbol

A named thing in the analysed code that has an identity beyond its spelling: two functions both called `parse` in different modules are two Symbols. A Symbol is addressed by name (`save`), qualified name (`User.save`) or position (`src/a.ts:42:7`).

## Declaration

The place where a Symbol is introduced, plus its **kind**: `function`, `class`, `method`, `property`, `variable`, `interface`, `type`, `enum`, `enum-member`, `namespace`. A Symbol can have several Declarations (overloads, interface merging). A Declaration is **exported** when another file can import it.

## Signature

The text of a Declaration without its body: name, parameters, return type, modifiers; for a class member, the member line; for a type, its full text. Compared between versions to classify a Change.

## Reference

Any place in the analysed code that names a Symbol, including its Declarations. A Reference is **inside** or **outside** a Change set.

## Via reference

A Reference that reaches the Symbol only through an interface or base-class member it implements or overrides: `parser.parse(raw)` with `parser: FieldParser` may run `DateParser.parse`, but names `FieldParser.parse`. Counted apart from the Symbol's own References. The uses of an Implementation, seen from the member it implements, are Via references too.

## Implementation

A class member that implements an interface member or overrides a base-class member. Its Declaration is never a Reference of the member it implements, nor of the other Implementations of that member.

## Caller

A Reference that invokes a function-like Symbol (call, `new`, tagged template). Every Caller is a Reference; a function passed as a value is a Reference but not a Caller.

## Outline

The list of top-level Declarations of one file (and the members of its classes), in source order, with exports marked.

## Change

A Declaration touched by a diff, with one of these classes:

- `added` - the Declaration exists only after.
- `removed` - the Declaration exists only before.
- `signature` - the Signature differs between before and after.
- `body` - only the body differs; the Signature is identical.
- `type` - a type-level Declaration (`interface`, `type`, `enum`) whose text differs.
- `modified` - changed, but the before version was unavailable, so it cannot be classified further.

## Impact

For one Change set: every Change, and for each changed Symbol the References outside the Change set, grouped by file, with Test files counted separately.

## Blind spot

A use of a changed Symbol that cannot be followed to a Symbol identity: access through `any`, a dynamic string key, reflection. Reported, never silently dropped.

## Unresolved match

A textual occurrence of a changed Symbol's name that is not a Reference. Only produced on request; kept apart from References because it may be noise.

## Test file

A source file that the project counts as a test, by path pattern. The set of patterns is per project and visible to the agent.

## Project

The set of source files analysed together, as the nearest `tsconfig.json` defines it, or an implicit one when no `tsconfig.json` is found.
