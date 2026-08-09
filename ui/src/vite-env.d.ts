/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PRIME_RPC_URL?: string
  readonly VITE_COSTON2_RPC_URL?: string
  readonly VITE_COSTON2_EXPLORER_API_URL?: string
  readonly VITE_REGISTRY_ADDRESS?: `0x${string}`
  readonly VITE_REGISTRY_DEPLOYMENT_BLOCK?: string
  readonly VITE_FCC_SENDER_ADDRESS?: `0x${string}`
  readonly VITE_FCC_RESULT_VERIFIER_ADDRESS?: `0x${string}`
  readonly VITE_FCC_INSTRUCTION_FEE_WEI?: string
}
