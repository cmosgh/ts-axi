import { User } from "../models/user";

export function legacySave(id) {
  const user = new User(id);
  return user.save();
}

legacySave("boot");
