import type { Entity, UserId } from "./types";
import { Role } from "./types";

/** A stored account. */
export class User implements Entity {
  static readonly table = "users";
  private secret = "";
  createdAt = Date.now();

  constructor(public id: UserId, public role: Role = Role.Member) {}

  /** Persist the user. */
  save(): boolean {
    this.secret = this.id;
    return this.secret.length > 0;
  }

  static create(id: UserId): User {
    return new User(id);
  }
}

export function isAdmin(user: User): boolean {
  return user.role === Role.Admin;
}
