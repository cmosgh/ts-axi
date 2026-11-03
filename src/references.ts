// Pure split of `findReferences` groups into direct / via / implementation / dropped.
// The LanguageService resolves a class member through the interface or base member it
// implements, so its result also holds sibling implementations and their call sites.

export interface RefDescriptor {
  /** Unique position key (`file#offset`). */
  key: string;
  /** The LanguageService marked it a Declaration of the queried Symbol. */
  isDefinition: boolean;
  /** It sits on the Declaration name of its own group's Symbol. */
  atDefinition: boolean;
  /** `super.name`: reaches the base member only. */
  isSuper: boolean;
}

export interface GroupDescriptor<R extends RefDescriptor> {
  /** Position key of the group's definition. */
  key: string;
  /** `Class.member` of the definition. */
  name: string;
  /** A class or interface member (an object literal member counts when it has bases). */
  member: boolean;
  /** Keys of every member this one implements or overrides, transitively. */
  bases: readonly string[];
  refs: readonly R[];
}

export type Through = "base" | "implementation";

export interface ViaRef<R> {
  ref: R;
  /** The member the Reference names (`FieldParser.parse`). */
  via: string;
  through: Through;
}

export interface Classified<R> {
  /** References of the queried Symbol itself (aliases included), Declarations excluded. */
  direct: R[];
  /** Declarations of the queried Symbol. */
  declarations: R[];
  /** References through a base member (`through: base`) or to an implementation of it (`through: implementation`). */
  via: Array<ViaRef<R>>;
  /** Declarations of members that implement or override the queried one. */
  implementations: Array<{ ref: R; name: string }>;
  /** Never a Reference of the queried Symbol: sibling implementations, their uses, `super` calls past it. */
  dropped: R[];
  /** Names of the members the queried one implements or overrides. */
  bases: string[];
}

type Bucket = "direct" | "declaration" | "via" | "implementation" | "dropped";
// A position reported in several groups keeps its most specific bucket.
const RANK: Record<Bucket, number> = { direct: 0, declaration: 1, implementation: 2, via: 3, dropped: 4 };

/**
 * Rules: the target group is direct. When the target is a class/interface member, a group it
 * implements/overrides (a base) is via, minus Declarations and `super` calls; a group that
 * implements/overrides the target is an implementation (its Declaration) or via (its uses);
 * any other member group is a sibling and dropped. Non-member groups (import aliases) are direct.
 */
export function classifyReferenceGroups<R extends RefDescriptor>(groups: readonly GroupDescriptor<R>[], targetIndex: number): Classified<R> {
  const target = groups[targetIndex];
  const best = new Map<string, { bucket: Bucket; ref: R; name: string; through?: Through }>();
  const put = (bucket: Bucket, ref: R, name = "", through?: Through): void => {
    const prev = best.get(ref.key);
    if (!prev || RANK[bucket] < RANK[prev.bucket]) best.set(ref.key, { bucket, ref, name, ...(through ? { through } : {}) });
  };
  const bases = new Set(target?.bases ?? []);
  groups.forEach((group, i) => {
    const isTarget = i === targetIndex;
    const relation = isTarget || !target?.member || !group.member
      ? "direct"
      : bases.has(group.key)
        ? "base"
        : group.bases.includes(target.key)
          ? "derived"
          : "sibling";
    for (const ref of group.refs) {
      switch (relation) {
        case "direct":
          put(ref.isDefinition || (isTarget && ref.atDefinition) ? "declaration" : "direct", ref);
          break;
        case "base":
          put(ref.isDefinition || ref.atDefinition || ref.isSuper ? "dropped" : "via", ref, group.name, "base");
          break;
        case "derived":
          if (ref.atDefinition) put("implementation", ref, group.name);
          else put("via", ref, group.name, "implementation");
          break;
        default:
          put("dropped", ref);
      }
    }
  });

  const result: Classified<R> = { direct: [], declarations: [], via: [], implementations: [], dropped: [], bases: [] };
  for (const { bucket, ref, name, through } of best.values()) {
    if (bucket === "direct") result.direct.push(ref);
    else if (bucket === "declaration") result.declarations.push(ref);
    else if (bucket === "via") result.via.push({ ref, via: name, through: through! });
    else if (bucket === "implementation") result.implementations.push({ ref, name });
    else result.dropped.push(ref);
  }
  result.bases = groups.filter((g, i) => i !== targetIndex && bases.has(g.key)).map((g) => g.name);
  return result;
}

/** `7 (FieldParser.parse)`: a count with the distinct member names, no commas. */
export function viaLine(count: number, names: readonly string[]): string {
  const distinct = [...new Set(names)];
  return distinct.length === 0 ? String(count) : `${count} (${distinct.join("; ")})`;
}
