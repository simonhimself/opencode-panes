// Wrangler cannot declare an optional secret binding. This augments its generated Env.
interface Env {
  PANES_CREATE_API_KEY?: string;
}
