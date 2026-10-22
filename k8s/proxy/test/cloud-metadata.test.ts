import { describe, it, expect } from 'vitest'
import { PLACEHOLDER_CLOUD_TOKEN, answerMetadata, isCloudApiHost, isMetadataHost } from 'yaac-proxy-sidecar/cloud-metadata'
import type { CloudCredential } from 'yaac-proxy-sidecar/objects'

/**
 * The stand-in metadata server, asked what gcloud and the Google auth
 * libraries ask the real one.
 */

const NOW = 1_000_000
const EMAIL = 'agents@demo.iam.gserviceaccount.com'
const cred: CloudCredential = {
  provider: 'gcp', identity: EMAIL, accessToken: 'ya29.real', expiresAt: NOW + 3_000_000,
  hostProject: { id: 'demo', number: '4242' },
}

const get = (url: string) => answerMetadata('GET', url, 'Google', cred, NOW)

describe('answerMetadata', () => {
  it('hands out a placeholder token for the project\'s identity, under either account name', () => {
    for (const account of ['default', EMAIL]) {
      const res = get(`/computeMetadata/v1/instance/service-accounts/${account}/token?scopes=x`)
      expect(res.status).toBe(200)
      expect(res.headers['Metadata-Flavor']).toBe('Google')
      expect(JSON.parse(res.body)).toEqual({ access_token: PLACEHOLDER_CLOUD_TOKEN, expires_in: 3000, token_type: 'Bearer' })
      expect(res.body).not.toContain('ya29.real')
    }
    expect(get('/computeMetadata/v1/instance/service-accounts/other@x.iam.gserviceaccount.com/token').status).toBe(404)
  })

  it('answers the probe and the account and project reads the libraries make', () => {
    expect(get('/').status).toBe(200)
    expect(get('/computeMetadata/v1/').status).toBe(200)
    expect(get('/computeMetadata/v1/instance/service-accounts/default/email').body).toBe(EMAIL)
    expect(get('/computeMetadata/v1/instance/service-accounts/default/scopes').body).toContain('cloud-platform')
    expect(JSON.parse(get('/computeMetadata/v1/instance/service-accounts/default/?recursive=true').body))
      .toEqual({ aliases: ['default'], email: EMAIL, scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
    expect(get('/computeMetadata/v1/instance/service-accounts/').body).toBe(`default/\n${EMAIL}/\n`)
    expect(Object.keys(JSON.parse(get('/computeMetadata/v1/instance/service-accounts/?recursive=true').body) as object))
      .toEqual(['default', EMAIL])
    expect(get('/computeMetadata/v1/project/project-id').body).toBe('demo')
    expect(get('/computeMetadata/v1/project/numeric-project-id').body).toBe('4242')
  })

  it('serves nothing else: no attributes, no ssh keys, no other paths', () => {
    for (const path of [
      '/computeMetadata/v1/instance/attributes/startup-script',
      '/computeMetadata/v1/project/attributes/ssh-keys',
      '/computeMetadata/v1/instance/service-accounts/default/identity?audience=x',
      '/latest/meta-data/',
    ]) expect(get(path).status, path).toBe(404)
  })

  it('refuses without the flavor header, and any method but GET', () => {
    expect(answerMetadata('GET', '/computeMetadata/v1/', undefined, cred, NOW).status).toBe(403)
    expect(answerMetadata('POST', '/computeMetadata/v1/', 'Google', cred, NOW).status).toBe(405)
  })

  it('reads as "not on GCE" for a project with no identity, and fails an expired token', () => {
    const none = answerMetadata('GET', '/computeMetadata/v1/instance/service-accounts/default/token', 'Google', undefined, NOW)
    expect(none.status).toBe(404)
    expect(none.headers['Metadata-Flavor']).toBeUndefined()
    const expired = { ...cred, expiresAt: NOW }
    expect(answerMetadata('GET', '/computeMetadata/v1/instance/service-accounts/default/token', 'Google', expired, NOW).status)
      .toBe(503)
  })
})

describe('isMetadataHost', () => {
  it('names the metadata address and GCP\'s name for it', () => {
    expect(isMetadataHost('169.254.169.254')).toBe(true)
    expect(isMetadataHost('metadata.google.internal')).toBe(true)
    expect(isMetadataHost('169.254.169.253')).toBe(false)
  })
})

describe('isCloudApiHost', () => {
  it('is every Google API host', () => {
    expect(isCloudApiHost('storage.googleapis.com')).toBe(true)
    expect(isCloudApiHost('googleapis.com.evil.example')).toBe(false)
  })
})
