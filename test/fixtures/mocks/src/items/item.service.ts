export class ItemService {
  async findItem(id: number): Promise<string> {
    return `item-${id}`;
  }
}

export class OtherService {
  async findItem(id: number): Promise<string> {
    return `other-${id}`;
  }
}
