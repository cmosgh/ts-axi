export interface Entity {
  id: string;
  createdAt: number;
}

export type UserId = string;

export enum Role {
  Admin = "admin",
  Member = "member",
}
