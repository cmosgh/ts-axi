import { ItemService, OtherService } from "./item.service";

export class ItemConsumer {
  constructor(private items: ItemService, private other: OtherService) {}

  show(id: number): Promise<string> {
    return this.items.findItem(id);
  }

  showOther(id: number): Promise<string> {
    return this.other.findItem(id);
  }
}
