import type { DeepMocked, Mocked, MockProxy } from "../mock-types";
import { expectCalled } from "../mock-types";
import type { ItemService, OtherService } from "./item.service";

export function deepMocked(items: DeepMocked<ItemService>): void {
  items.findItem.mockResolvedValue("a");
  void items.findItem(1);
  expectCalled(items.findItem);
}

export function otherShapes(a: Mocked<ItemService>, b: MockProxy<ItemService>, c: Partial<ItemService>, d: Pick<ItemService, "findItem">): void {
  a.findItem.mockResolvedValue("b");
  void b.findItem(2);
  void c.findItem?.(3);
  void d.findItem(4);
}

export function unrelated(o: DeepMocked<OtherService>): void {
  o.findItem.mockResolvedValue("x");
}
