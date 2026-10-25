import { accountSealingAvailable, attestPagesWithAccount } from "./accountSealing.js";
export const googleSealingAvailable = accountSealingAvailable;
export const attestPagesWithGoogle = (pages, options) => attestPagesWithAccount("google", pages, options);
