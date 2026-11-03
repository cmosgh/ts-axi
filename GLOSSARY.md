# Glossary

Terms used by ts-axi, its output and its documentation. Implementation details do not belong here.

## Symbol

A named thing in the analysed code that has an identity beyond its spelling: two functions both called `parse` in different modules are two Symbols. A Symbol is addressed by name (`save`), qualified name (`User.save`) or position (`src/a.ts:42:7`).

## Declaration

The place where a Symbol is introduced, plus its **kind**: `function`, `class`, `method`, `property`, `variable`, `interface`, `type`, `enum`, `enum-member`, `namespace`. A Symbol can have several Declarations (overloads, interface merging). A Declaration is **exported** when another file can import it. A **nested declaration** is one of a bounded set of script-style patterns found below the top level: a string-registered callback (`.controller('Name', fn)`, qualified `Name`), a method of an object literal handed to a known holder (`methods.a`, `Template.x.helpers.a`, `exports.a`, `api.a` for `const api = {...}`), a prototype or static assignment (`Foo.bar`), a `this.x = function` in a constructor (`Foo.x`), or a function at the top level of an IIFE (`helper`, not exported); string-registered ones are **nameless** (no identifier, References are textual).

## Signature

The text of a Declaration without its body: name, parameters, return type, modifiers; for a class member, the member line; for a type, its full text. For a `variable`, class field or enum member it is the keyword, name and type annotation: the initializer is the body (a function-valued initializer keeps its parameters and return type). Compared between versions to classify a Change.

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

The set of source files analysed together, as the nearest `tsconfig.json` defines it (a tsconfig that only references others stands for the union of the ones it references), or an implicit one when no `tsconfig.json` is found. Inside a Workspace, also one of its members: a directory with its own tsconfigs, such as an Nx project or a workspace package.

## Workspace

A repository holding several Projects that use each other, recognised from files it already has (`nx.json`, `pnpm-workspace.yaml`, `package.json` `workspaces`, a root tsconfig of references). Its path aliases and package names decide how one Project imports another.

## Importer

A file that imports another file, directly or through a barrel that re-exports it. Found by reading import specifiers as text, before any type check.

## Scope

The files a semantic command actually analysed: the seed files (the declaring file, or the files a Change touches) plus their Importers. Printed with every result in a Workspace, and marked partial when the search for Importers stopped early.
