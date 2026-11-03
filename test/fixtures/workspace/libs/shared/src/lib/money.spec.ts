import { roundCents } from "./money";

export const roundsHalfUp = roundCents(1.5) === 2;
