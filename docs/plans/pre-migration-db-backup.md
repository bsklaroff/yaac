# A DB copy before each migration

Migrations apply on server start (`getDb()` runs `migrate()`). On a cluster
install a server image rollout therefore migrates the database in place, and
rolling back the image leaves the old code on a schema it does not know.
Provider snapshots of the volumes are the operator's job, but they are not
taken at the right moment.

## Proposal

Before running a pending migration, the server takes a cold copy of
`<serverLocal>/db` to `<serverLocal>/db-backup-<buildId>`, keeping the last
N. Only when a migration is pending, so an ordinary restart costs nothing.
Document how to roll back: stop the server, swap the copy in, deploy the
previous image. The containerless install can share the mechanism.
