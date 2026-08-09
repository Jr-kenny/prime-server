import { fallback, http } from "viem";
import { coston2 } from "./registry";

export function coston2Transport() {
  return fallback(
    coston2.rpcUrls.default.http.map((url) => http(url, {
      retryCount: 1,
      retryDelay: 500,
      timeout: 12_000
    })),
    {
      retryCount: 2,
      retryDelay: 500
    }
  );
}
