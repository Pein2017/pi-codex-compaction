import { isDeepStrictEqual } from "node:util";
import { type Context, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

/**
 * Context Management opt-in only. normalizeContext prepends legacy prompt/tools
 * to a transcript that may already declare them. Remove only proven duplicates;
 * retain all persisted system messages, sections and ordered tool deltas.
 * A differing effective (including forced) prompt is not proof that persisted
 * instructions are disposable: keep both, and do not promise prefix equality.
 */
export function preserveAffinityContext(context: Context): Context {
  if (!context.messages.some((message) => message.role === "system")) return context;
  const { systemPrompt, tools, ...transcript } = context;
  const declared = getCurrentTools(context.messages);
  // Public getAllTools omits constrainedSampling: an absent outer constraint
  // does not replace the persisted one. But every explicitly supplied outer
  // field (including false, constraint configs and unknown future fields) must
  // match before removing that declaration. Never silently discard overrides.
  const visible = (values: typeof declared) =>
    JSON.stringify(values.map(({ name, description, parameters }) => ({ name, description, parameters })));
  const redundantTools =
    tools !== undefined &&
    visible(declared) === visible(tools) &&
    tools.every((outer, index) =>
      Object.entries(outer).every(
        ([key, value]) => value === undefined || isDeepStrictEqual(value, Reflect.get(declared[index], key)),
      ),
    );
  return {
    ...transcript,
    ...(systemPrompt === getCurrentSystemPrompt(context.messages) ? {} : { systemPrompt }),
    ...(redundantTools ? {} : { tools }),
  };
}
