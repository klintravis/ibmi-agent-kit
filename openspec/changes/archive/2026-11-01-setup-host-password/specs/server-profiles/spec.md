# Spec Delta

## ADDED Requirements

### Requirement: setup keeps a password only for the same host
In personal and company-repo mode alike, `setup` SHALL offer to keep the profile's current password
(Enter at the password prompt) only when the host the profile will hold equals its current
`IBMI_HOST`. Otherwise it SHALL ask for a password with no default, SHALL say that the old host is
replaced when the profile had one, and SHALL neither write nor send the old password.

#### Scenario: Host changed
- **WHEN** `.env.prod` holds `IBMI_HOST=old.example.com` and a password, and `setup prod` outside a
  company repo gets `new.example.com` at the host prompt and Enter at the password prompt
- **THEN** `setup` says `old.example.com` is replaced by `new.example.com`, does not offer to keep
  the current password, asks for the password again, and the old password is neither written to
  `.env.prod` nor sent in the connection test

#### Scenario: Host unchanged
- **WHEN** `.env.prod` holds `IBMI_HOST=old.example.com` and a password, and `setup prod` gets
  Enter at the host prompt and Enter at the password prompt
- **THEN** `setup` offers to keep the current password and the profile keeps it

#### Scenario: Old profile has no host
- **WHEN** `.env.prod` holds a password but no `IBMI_HOST`
- **THEN** `setup prod` asks for the password with no default
