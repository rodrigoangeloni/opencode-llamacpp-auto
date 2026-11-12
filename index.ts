/**
 * llama.cpp as a dynamic OpenCode provider.
 *
 * Finds a local `llama-server` on its own, publishes the model it currently
 * has loaded (context window, vision, tools) and exposes reasoning variants
 * based on what the model's chat template supports. It refreshes every 15 s,
 * so switching models in llama.cpp needs neither a config edit nor a restart.
 *
 * No configuration required. Optional: LLAMACPP_BASE_URL=http://127.0.0.1:PORT
 */
import { Model, Plugin, Provider } from "@opencode/plugin"

const PROVIDER_ID = "llamacpp"
const PROVIDER_NAME = "llama.cpp (local)"
const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"

const REFRESH_INTERVAL_MS = 15_000
const REQUEST_TIMEOUT_MS = 2_000
const MISSES_BEFORE_REMOVE = 20
const FALLBACK_CONTEXT = 32_768
const MAX_OUTPUT = 32_768
const DEFAULT_PORTS = [8080, 9931, 1234, 8000]

type Props = {
  model_alias?: string
  build_info?: string
  modalities?: { vision?: boolean; video?: boolean; audio?: boolean }
  default_generation_settings?: { n_ctx?: number }
  chat_template?: string
  chat_template_caps?: {
    supports_tool_calls?: boolean
    supports_vision?: boolean
    supports_reasoning_effort?: boolean
    reasoning_effort_levels?: string[]
  }
}

type RemoteModel = {
  id: string
  tags?: string[]
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
  meta?: { n_ctx?: number } | null
}

type Inventory = { data?: RemoteModel[] }

type Discovered = {
  baseURL: string
  info: Provider.Info
  models: Model.Info[]
}

const providerID = Provider.ID.make(PROVIDER_ID)

function candidates(): string[] {
  const override = process.env.LLAMACPP_BASE_URL?.trim()
  const urls = override ? [override] : DEFAULT_PORTS.map((port) => `http://127.0.0.1:${port}`)
  return [...new Set(urls.map(normalizeBaseURL))]
}

function normalizeBaseURL(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) return undefined
    return (await response.json()) as T
  } catch {
    return undefined
  }
}

function inputModalities(props: Props, model: RemoteModel): string[] {
  const declared = new Set<string>(["text"])
  for (const item of model.architecture?.input_modalities ?? []) declared.add(item)
  if (props.modalities?.vision) {
    declared.add("image")
    if (props.modalities.video !== false) declared.add("video")
  }
  if (props.modalities?.audio) declared.add("audio")
  return [...declared]
}

function outputModalities(model: RemoteModel): string[] {
  const declared = model.architecture?.output_modalities ?? []
  return declared.length > 0 ? [...declared] : ["text"]
}

function contextLength(props: Props, model: RemoteModel): number {
  const value = props.default_generation_settings?.n_ctx ?? model.meta?.n_ctx
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : FALLBACK_CONTEXT
}

function displayName(id: string, props: Props): string {
  const alias = props.model_alias?.trim()
  if (alias) return alias
  const file = id.split(/[\\/]/).pop() ?? id
  return file.replace(/\.gguf$/i, "")
}

/**
 * Reasoning variants from the model's chat template:
 * - template accepts effort levels -> one variant per level
 * - template only exposes `enable_thinking` -> on / off
 */
function reasoningVariants(props: Props): Model.Info["variants"] {
  const caps = props.chat_template_caps ?? {}
  const levels = (caps.reasoning_effort_levels ?? []).filter((level) => level.length > 0)

  if (caps.supports_reasoning_effort && levels.length > 0) {
    return levels.map((level) => ({
      id: Model.VariantID.make(level),
      body: { reasoning_effort: level },
    }))
  }

  if (props.chat_template?.includes("enable_thinking")) {
    return [
      { id: Model.VariantID.make("none"), body: { chat_template_kwargs: { enable_thinking: false } } },
      { id: Model.VariantID.make("thinking"), body: { chat_template_kwargs: { enable_thinking: true } } },
    ]
  }

  return []
}

function toModelInfo(props: Props, model: RemoteModel): Model.Info {
  const context = contextLength(props, model)
  const base = Model.Info.default(providerID, Model.ID.make(model.id))
  const input = inputModalities(props, model)
  const output = outputModalities(model)

  return {
    ...base,
    name: displayName(model.id, props),
    capabilities: {
      tools: props.chat_template_caps?.supports_tool_calls ?? output.includes("text"),
      input,
      output,
    },
    limit: {
      context,
      output: Math.min(MAX_OUTPUT, context),
    },
    variants: reasoningVariants(props),
  }
}

async function discoverAt(baseURL: string): Promise<Discovered | undefined> {
  const health = await getJson<{ status?: string }>(`${baseURL}/health`)
  if (health?.status !== "ok") return undefined

  const [props, inventory] = await Promise.all([
    getJson<Props>(`${baseURL}/props`),
    getJson<Inventory>(`${baseURL}/v1/models`),
  ])
  if (!props) return undefined

  const entries = (inventory?.data ?? []).filter(
    (item) => typeof item?.id === "string" && item.id.length > 0 && !(item.tags ?? []).includes("embedding"),
  )
  if (entries.length === 0) return undefined

  const info: Provider.Info = {
    ...Provider.Info.empty(providerID),
    name: PROVIDER_NAME,
    activation: "enabled",
    package: PROVIDER_PACKAGE,
    settings: { baseURL: `${baseURL}/v1` },
  }

  return { baseURL, info, models: entries.map((model) => toModelInfo(props, model)) }
}

async function detect(): Promise<Discovered | undefined> {
  for (const baseURL of candidates()) {
    const found = await discoverAt(baseURL)
    if (found) return found
  }
  return undefined
}

export default Plugin.define({
  id: "llamacpp-auto",
  async setup(ctx) {
    let current: Discovered | undefined
    let fingerprint = ""
    let misses = 0

    // The transform is replayed on every `provider.reload()`, so it always
    // publishes the most recently discovered inventory.
    await ctx.provider.transform((editor) => {
      if (!current) return
      editor.add({ info: current.info, models: current.models })
    })

    const sync = async (force = false) => {
      const next = await detect()

      if (!next) {
        misses += 1
        if (current && misses >= MISSES_BEFORE_REMOVE) {
          current = undefined
          fingerprint = ""
          await ctx.provider.reload()
        }
        return
      }

      misses = 0
      const nextFingerprint = JSON.stringify({
        baseURL: next.baseURL,
        models: next.models.map((model) => ({
          id: model.id,
          name: model.name,
          capabilities: model.capabilities,
          limit: model.limit,
          variants: model.variants,
        })),
      })
      if (!force && nextFingerprint === fingerprint) return

      current = next
      fingerprint = nextFingerprint
      await ctx.provider.reload()
    }

    await sync(true)

    const timer = setInterval(() => {
      void sync().catch(() => undefined)
    }, REFRESH_INTERVAL_MS)

    return () => clearInterval(timer)
  },
})
