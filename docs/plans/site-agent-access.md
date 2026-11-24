# Agent access to tailnet sites

A workspace reaches no tailnet site: the site domain resolves only on the
tailnet, and a workspace is not on it (docs/public-sites.md "Tailnet
sites"). This plan gives a tailnet site a door for agents, so an internal
app can offer them an API of its own, such as an MCP server.

An agent that comes through the door is never a person. It arrives on a
port of its own with an identity of its own, and the app decides what that
identity may do.

## The agent door

A tailnet site may name an **agent port**. A workspace's request for the
site's hostname is carried to that port, with headers that say which
workspace sent it.

```
person on the tailnet ─► tailgate ─► router 8081 ─► release :<port>
                                       requires Tailscale-User-Login

agent in a workspace ─► egress proxy ─► router 8082 ─► release :<agent port>
                                          requires Yaac-Agent-Workspace
```

- **The site opts in.** A site with no agent port is in no agent route, so
  no workspace reaches it. The port differs from the site's port and its
  admin port, and moves from the next deploy, as they do.
- **The app opts in again**, by listening there. What it serves on its own
  port is unchanged and still sees only people.
- **Same URL.** An agent asks for `https://<site hostname>/…`, the address
  a person opens. Which door answers follows from who is asking.

### The egress proxy

For a name under the site domain the proxy:

1. checks the allowlist. An entry must name the host or the whole zone
   (`*.apps.example.com`); a bare `*` does not count. The entry is the
   project owner's consent for the project's agents to act there, so it
   should not come with unrestricted egress.
2. refuses plain HTTP with a 403 naming the `https://` URL, and otherwise
   ends the workspace's TLS with a leaf for the hostname.
3. drops every `Yaac-*`, `Tailscale-*`, `X-Forwarded-*` and `CF-*` header
   the workspace sent, sets the agent headers below and `X-Forwarded-Proto:
   https`, and sends the request to the router's agent listener with `Host`
   unchanged. It does this after every injection, so a project secret's
   rule cannot set one of these headers.

A release gets a 403: it faces the internet and has no identity to send.

The proxy holds no list of sites. It knows the site domain and the
listener's address, which the server hands it when it deploys it.

### The router

A third listener, 8082, with a route table of its own. A site is a virtual
host there only while it is published and names an agent port, routed to
its Service at that port. The listener answers 403 to a request without
`Yaac-Agent-Workspace`, as the tailnet listener does for a login, and drops
the `Tailscale-*` identity headers, as the public listener does.

### Network policy

- The per-site policy admits router pods on the agent port too.
- The router admits the egress proxy on 8082, and the proxy's egress names
  router pods there. No tunnel is admitted to it.
- **8082 is reserved in the proxy.** The proxy also dials whatever a
  workspace's allowlist names, and policy cannot tell that dial from the
  agent route, since both come from the proxy. So the proxy refuses a
  non-public address on that port on every dial path but the agent route,
  whose target it names itself. Otherwise a project that allowed the
  router's address could send any `Host` and any agent headers.

`yaac cluster check`'s `sites` gate holds probes to these: a workspace pod
and each tunnel's pod must fail to dial 8082.

## Headers an app may trust on the agent port

| Header | Value |
|---|---|
| `Yaac-Agent-Workspace` | the workspace's id |
| `Yaac-Agent-Project` | its project's id |
| `Yaac-Agent-Owner` | the tailnet login of the project's owner, whom the agent works for |

The server puts these in the workspace's proxy registration, and the proxy
copies them from there. A workspace whose owner has no tailnet login is
refused, as a release is.

No other door carries them. tailgate drops every `Yaac-*` header a caller
sent, and the router's public and tailnet tables remove the three by name
(docs/public-sites.md "Headers an app may trust"). The agent listener
requires one and only the proxy reaches it, so a process on the agent port
sees only requests that carry a true agent identity, and a process on the
site's port never sees one.

`Yaac-Agent-Owner` says whom the agent works for, not who is asking. An
app that gives an agent everything its owner has rebuilds what this plan
avoids, and should instead say what an agent may do: read but not delete,
say, or only what the owner marked for agents.

## Who may reach a site's agent door

Three things must all hold: the site names an agent port, the project's
allowlist names the host, and the app admits the identity it is shown.

Any user's project can meet the first two. The door is open to every
project in the install whose owner allows the host, as a tailnet site is
open to every user the tailnet's ACLs let reach the tunnel. Telling
projects and owners apart is the app's job.

## MCP

An app serves its MCP endpoint on the agent port, and a workspace's tool
is configured with the site's `https://` URL. The headers are the
authentication: the app needs no OAuth, no API key and no sign-in page for
agents, as it needs none for people behind `Tailscale-User-Login`.

An agent outside yaac, on a tailnet device that belongs to a user, is not
a workspace. It comes through tailgate to the site's own port as that user.
An app that wants one MCP endpoint for both serves it on both ports and
reads whichever identity the port carries.

### Scopes and revocation: tokens from the issuer

The headers say which agent is asking. An app that wants narrower grants
than "this project's agents", or one it can take back without touching the
allowlist, checks a token as well. The issuer of
docs/plans/site-identity.md already has what this needs:

- The app is registered as a **resource**, whose identifier is the token's
  audience.
- A **machine client** is registered for the project on the issuer's admin
  port, with a ceiling on the scopes it may ask for
  (`client_credentials_scopes`).
- The client's secret is a project secret whose rule names the issuer's
  token endpoint and the `client_secret` form field. The agent asks for a
  token with a placeholder, the egress proxy puts the secret in, and the
  agent holds only the token: an hour long and good for that one app.

The app then requires both: a request on the agent port, and a token whose
audience is the app. This layer is the issuer's and the app's. yaac changes
nothing for it.

## Surfaces

The agent port reaches the API, CLI and webapp like the admin port:

- a field on site create and edit, covered by the existing site rows in
  `test/api/route-matrix.ts`;
- `yaac site` and `yaac-mama site` options to set and clear it, each with an
  e2e test. An agent may set it on an unpublished site, which is in no
  route table; on a published one it is a person's, like every other
  setting (docs/public-sites.md "Publishing");
- a field in the site form, and the port in `site show`;
- the blocked-hosts badge offers to allow a tailnet site a workspace was
  refused, with a line saying the project's agents will reach it as
  agents.

## Not in this plan

- **An agent door on a public site.** Its hostname is not under the site
  domain, so the proxy would need the list of sites to tell its requests
  from the internet's. An agent already reaches a public site over the
  internet, as a visitor.
- **A release calling another site.** A release has no identity.
- **Which projects may reach a site**, as a rule at the router. The app
  decides.
- **The tool's side of MCP**: writing the site's URL into each tool's MCP
  settings for a workspace.

## Verify before building

1. Each tool's MCP client reaches an `https://` MCP endpoint through the
   proxy's certificate, with no credential configured, and keeps a
   streaming response open as long as the router's idle timeout allows.
2. A request to the site's hostname from a workspace arrives on the agent
   port with the three headers and none a workspace sent under those
   names; the same request from a tailnet device arrives on the site's
   port with none of them.
3. A workspace cannot reach 8082 except through the agent route: a direct
   dial is dropped by policy, and an allowlist entry for the router's
   address is refused by the proxy.
4. A site with no agent port, an unpublished site, a release and a
   workspace whose owner has no login each get a refusal, and none reaches
   a release.
5. For the token layer: which grants each tool's MCP client can use, and
   whether a token request made with a placeholder secret completes once
   the proxy replaces it in the form body.

## Alternatives considered

- **The agent as its owner.** The proxy could set the owner's
  `Tailscale-User-Login` and use the tailnet listener. An app then cannot
  tell a person from their agent, so every tailnet site is open to every
  agent whose project allows the zone, with everything its owner may do.
- **One listener, with a header marking agents.** The tailnet listener's
  promise is that an app sees only requests with a login. Admitting agents
  there breaks it for every app, including those that never asked for
  agents, and makes a missed check in an app a way in.
- **Tokens alone, on a public hostname.** An MCP endpoint that checks a
  token can be served to the internet with no yaac change. It is then on
  the internet, which is what a tailnet site exists to avoid.
