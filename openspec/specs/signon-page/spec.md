# signon-page Specification

## Purpose
Lets a user of the kit server give a password, and create a first profile, on a one-time page on their
own machine, with no command line, while the password never reaches the client, the model or any output.

## Requirements

### Requirement: A store profile with no stored password is offered the page
When a sign-on through the kit server fetches the password of a profile with `IBMI_PASSWORD_STORE=os`
and the OS store has no entry for its user and host, the tool call SHALL fail without sending a password,
and its error SHALL keep the pointers to `ibmi-agent-kit credential set` and `IBMI_PASSWORD_COMMAND` and
SHALL offer the page. A store that cannot be read, a helper profile and a plain password profile SHALL
NOT be offered the page and SHALL keep their existing behaviour.

#### Scenario: Missing entry
- **WHEN** `session_open` runs on a store profile whose entry does not exist
- **THEN** the call fails, nothing is sent to the box, and the error offers the page and names `credential set`

#### Scenario: Store cannot be read
- **WHEN** the OS store is unavailable on the read
- **THEN** the call fails with the existing store error and no page is offered

#### Scenario: Helper profile
- **WHEN** a profile with `IBMI_PASSWORD_COMMAND` has a helper that fails or a password that is rejected
- **THEN** no page is offered and the existing error stands

#### Scenario: Plain profile
- **WHEN** a profile with only `IBMI_PASSWORD` has its password rejected
- **THEN** no page is offered and the next attempt fails without sending, as before

### Requirement: The tool call does not wait for the user
A tool call SHALL return its failure as soon as the page is offered and SHALL NOT wait for the page or
for the client's answer to the offer. A submission SHALL only store the password and SHALL NOT sign on.
The next tool call SHALL fetch the stored password and send it at most once.

#### Scenario: One page per pending account
- **WHEN** a guarded SQL call fails its identity lookup and its own query for one store profile with no entry
- **THEN** one page exists, both failures refer to it, and no password is sent

#### Scenario: Submit then retry
- **WHEN** the user submits the page and the tool is called again
- **THEN** the submission sends nothing and the next call sends the password once

#### Scenario: Client never answers
- **WHEN** the client does not answer the offer
- **THEN** the tool call still returns at once, and later sign-ons for other accounts are not held up

### Requirement: The offer reaches the user on every client
When the client declares URL elicitation, the server SHALL offer the page through it, and the first
failure SHALL say that a prompt was offered and to call again if none appeared, without the link. In every
other case the failure SHALL print the link: the client does not declare URL elicitation, the client
declined or the request failed, or the offer has had no answer after 10 seconds.

#### Scenario: Elicitation unsupported
- **WHEN** the client does not declare URL elicitation
- **THEN** the tool error prints the link and no elicitation request is sent

#### Scenario: Elicitation pending
- **WHEN** the client declares URL elicitation and has not answered yet
- **THEN** the first error holds no link and says a prompt was offered

#### Scenario: Silent decline
- **WHEN** the client answers the offer with a decline and the tool is called again
- **THEN** that error prints the link for the same page

#### Scenario: Unanswered offer
- **WHEN** the offer has had no answer for 10 seconds and the tool is called again
- **THEN** that error prints the link for the same page

### Requirement: A submission tells an elicited client it is done
After an accepted submission of a page offered through elicitation, the server SHALL send the elicitation
completion notification. A failure to send it SHALL NOT affect the submission.

#### Scenario: Completion after a submit
- **WHEN** the user submits a page that was offered through elicitation
- **THEN** the client gets the completion notification, holding no password

#### Scenario: Link fallback only
- **WHEN** the user submits a page offered only through the printed link
- **THEN** no notification is sent

### Requirement: Only the user's own browser reaches the page
The page SHALL listen on 127.0.0.1 only and SHALL refuse a request whose Host is not a loopback name. It
SHALL require a random token of at least 128 bits. The token SHALL expire 5 minutes after the offer and
SHALL stop working once a submission is accepted. A GET SHALL show the form and SHALL NOT use up the token.

#### Scenario: DNS rebinding
- **WHEN** a request carries a valid token and `Host: evil.example`
- **THEN** it is refused and nothing changes

#### Scenario: Token used twice
- **WHEN** a second POST arrives with the token of an accepted submission
- **THEN** it is refused and the store is not written

#### Scenario: Token expired
- **WHEN** a request arrives more than 5 minutes after the offer
- **THEN** it is refused, and the next failing tool call offers a new page with a new token

#### Scenario: Link preview
- **WHEN** something fetches the link with GET before the user does
- **THEN** the token still works for the user's submission

### Requirement: A submission is a POST with the token in its body
A submission SHALL be a POST with the token in its body. A POST with an Origin other than the page's own
SHALL be refused. The page SHALL take no value from its URL other than the token.

#### Scenario: Cross-site post
- **WHEN** a POST arrives with a foreign Origin, or with the token only in the query string
- **THEN** it is refused and the store is not written

#### Scenario: Values from the URL
- **WHEN** the link is opened with `host` or `user` added to its query string
- **THEN** the page ignores them

### Requirement: Every page response is locked down
Every response, refusals included, SHALL set `cache-control: no-store`, a content security policy with
`frame-ancestors 'none'`, and `referrer-policy: same-origin`. The page SHALL run no script.

#### Scenario: Response headers
- **WHEN** the page answers a GET, a POST or a refused request
- **THEN** the response carries those three headers and holds no script

### Requirement: The password stays on the page
A password submitted on the page SHALL go only to the OS store. It SHALL NOT appear in a URL, tool output,
an elicitation message, a notification, the run log, standard error, a profile file, or any response of
the page, including an error response. The page SHALL NOT be offered through form elicitation.

#### Scenario: Secret absent from every output
- **WHEN** a known password is submitted, accepted by the store, and the tool is called again, once with a
  store that fails and once with a rejection by the box
- **THEN** the password is absent from every tool result, client notification, run log line, standard error
  line and page response

### Requirement: The page says what a submission does
The page SHALL name the host and the user the password will be sent to, escaped as text. It SHALL warn that
a wrong password counts as a failed sign-on toward `QMAXSIGN` and can disable the user.

#### Scenario: Page text
- **WHEN** the user opens the page for a store profile on `pub400.com`
- **THEN** it shows that host and the user, and the `QMAXSIGN` warning, before the password field

#### Scenario: Value from a profile file
- **WHEN** a profile's host or user holds HTML
- **THEN** the page shows it as text

### Requirement: A rejected password is offered the page once more
When an attempt is refused because the store still holds a rejected password, the error SHALL offer the page
if no earlier submission for that user and host followed a rejection in this process. After that the
error SHALL name only `credential set` and the restart. A helper or plain profile SHALL NOT get this offer.
An offer that expires unused SHALL NOT count.

#### Scenario: Offered after a rejection
- **WHEN** a store profile's password is rejected and the tool is called again
- **THEN** that call sends nothing and its error offers the page

#### Scenario: Second wrong password
- **WHEN** the password from that page is rejected too and the tool is called again
- **THEN** that call sends nothing and the error offers no page and names `credential set` and the restart

#### Scenario: Offer expires unused
- **WHEN** a re-offered page expires with no submission and the tool is called again
- **THEN** that call sends nothing and its error offers a new page

### Requirement: The page leaves the rejected-password record unchanged
The rejected-password record SHALL work as it does without the page: a value already rejected SHALL NOT be
sent again, and a new value SHALL be sent once and cost a real attempt.

#### Scenario: Same wrong password typed again
- **WHEN** the value submitted equals the rejected one
- **THEN** the next call sends nothing

#### Scenario: New value
- **WHEN** the value submitted differs from the rejected one
- **THEN** the next call sends it once, and it counts as a real attempt on the box

### Requirement: The link passing through the model is limited
When a failure prints the link, its text SHALL tell the model to hand the link to the user and not to open
it. The link SHALL hold only the loopback address and the token. A submission SHALL write only to the store
and, for a first profile, the profile file. The page SHALL NOT return whether a password is correct, and
SHALL NOT read back a stored value.

#### Scenario: Fallback text
- **WHEN** a tool error prints the link
- **THEN** it says the link is for the user to open, that it starts with `http://127.0.0.1:`, and that the
  password must never be typed into the chat

#### Scenario: Nothing about the account in the link
- **WHEN** a link is built for a profile
- **THEN** it holds neither the host, the user nor the profile name

#### Scenario: Agent submits a wrong password
- **WHEN** an agent holding the link posts a wrong password
- **THEN** the page stores it without saying whether it is right, the next call sends it once, and the
  re-offer limit applies

### Requirement: With no profile, list_servers offers a first-profile page
When no profile exists, `list_servers` SHALL offer the page in its text, under the same delivery rules. An
unknown server error with no profile listed SHALL add that `list_servers` offers a setup page. With at least
one profile, `list_servers` and an unknown server name SHALL behave as before. `list_servers` SHALL stay
read-only: only a person's submission writes anything.

#### Scenario: Brand-new user, no company repo
- **WHEN** `list_servers` runs with no profile and the current folder is not a company config repo
- **THEN** the offered page asks for host, user and password, and creates the `default` profile

#### Scenario: Company repo with one partition
- **WHEN** the current folder holds `policy.yaml` and `profiles/.env.dev`, and no profile exists
- **THEN** the page shows that skeleton's partition and host and asks only for the user and password, and
  creates profile `dev`

#### Scenario: Company repo with several partitions
- **WHEN** the repo holds several skeletons
- **THEN** the page lists them and creates the profile for the one chosen

#### Scenario: Unknown name with no profile
- **WHEN** `run_sql` runs with `server: pub400` and no profile exists
- **THEN** it fails with `Available: none` and says `list_servers` offers a setup page

#### Scenario: Typo with profiles present
- **WHEN** `run_sql` runs with `server: dve` and profile `dev` exists
- **THEN** it fails naming the available servers, as before, with no offer

### Requirement: A first profile is written by the rules of setup
The page SHALL write the profile with the same rules as `setup`: `IBMI_PASSWORD_STORE=os` and no password
in the file; the store written before the file, and nothing written when the store fails; an atomic write
with mode 600 in a folder with mode 700 on macOS and Linux; a read-back check; values dotenv cannot hold
refused.

#### Scenario: Written profile
- **WHEN** a first-profile submission is accepted
- **THEN** the file sets `IBMI_PASSWORD_STORE=os` and the host and user, and holds no password

#### Scenario: Store failure
- **WHEN** a first-profile submission fails to write the store
- **THEN** no profile file is written and the page shows the store message

#### Scenario: Value dotenv cannot hold
- **WHEN** a submitted host or user holds a line break
- **THEN** the page refuses it and writes nothing

### Requirement: A first profile takes only safe settings from a skeleton
From a skeleton the page SHALL copy every setting except `IBMI_USER`, `IBMI_PASSWORD`, `IBMI_PASSWORD_COMMAND`,
`IBMI_PASSWORD_STORE` and `IBMI_KIT_POLICY`, SHALL refuse a skeleton without `IBMI_HOST` or `IBMI_PARTITION`,
SHALL warn about a password or helper in it, and SHALL set `IBMI_KIT_POLICY` to the repo's `policy.yaml` after
loading it.

#### Scenario: Password in a skeleton
- **WHEN** `profiles/.env.dev` holds `IBMI_PASSWORD` and `IBMI_PASSWORD_COMMAND`
- **THEN** neither is copied, the helper is never run, and the page warns to remove them from the repo

#### Scenario: Skeleton without a host
- **WHEN** a skeleton has no `IBMI_HOST`
- **THEN** the page refuses it and writes nothing

### Requirement: A first profile refuses an unsafe folder and an existing profile
The page SHALL NOT be offered, and a submission SHALL write nothing, when the first profile folder or a
profile file linked from it lies in a git work tree or in the company repo. A submission SHALL NOT overwrite
a profile that has appeared since the offer.

#### Scenario: Profile folder in a git work tree
- **WHEN** `IBMI_KIT_CONFIG_DIR` lies in a git work tree and no profile exists
- **THEN** `list_servers` offers no page, says why, and names `setup`, and nothing is written

#### Scenario: Profile appears meanwhile
- **WHEN** `setup` creates a profile after the offer and the page is then submitted
- **THEN** the submission is refused and the store and the file are unchanged

### Requirement: The terminal stays the route where the page cannot work
The page SHALL NOT keep a password in memory as a fallback when the store cannot be written, and SHALL
point at `IBMI_PASSWORD_COMMAND`. Every offer SHALL also name `credential set` or `setup` for a session whose
browser cannot reach this machine. `setup` and `credential` SHALL NOT serve a page.

#### Scenario: No Secret Service on Linux
- **WHEN** a first-profile page is submitted on a Linux machine with no Secret Service
- **THEN** the page shows the store message pointing at `IBMI_PASSWORD_COMMAND` and nothing is written

#### Scenario: Store profile with no Secret Service
- **WHEN** a store profile signs on where the store cannot be read
- **THEN** the call fails with the existing store error and no page is offered

#### Scenario: Remote session
- **WHEN** the server runs on a machine whose loopback the user's browser cannot reach
- **THEN** the offer still names the terminal commands, and the page expires unused

### Requirement: Standalone engines keep their behaviour
The standalone screen and source servers SHALL NOT serve a page, and their errors and `list_servers` text
SHALL stay as they are.

#### Scenario: Standalone source server
- **WHEN** the source engine runs on its own with a store profile that has no entry
- **THEN** the existing missing-entry error is returned, with no link and no offer
