# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

The integration stores nothing on disk: `/data` stays empty, and the forecasts,
observations and warnings live in memory only. It holds no secret (FMI needs no
key) and makes only HTTPS requests: to `opendata.fmi.fi` for the forecast and
the observations, carrying the coordinates of the houses of Gladys rounded to 4
decimals, and to `alerts.fmi.fi` for the warning feed, carrying no location. It
reads the houses through the Gladys host API (`location: true`) and opens no
port. An answer of either service is parsed as data only (regular expressions
over bounded XML, no evaluation, no XML entity expansion), then bounded again
by the core.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the FMI services.
