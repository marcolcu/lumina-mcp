import { useTranslation, Trans } from 'react-i18next'


export function TestingDocs() {
  const { t } = useTranslation()

  return (
    <>
      <div className="mb-8">
        <span className="text-accent font-semibold tracking-wider text-sm uppercase">{t('docs.testing.badge', 'TESTING')}</span>
        <h1 className="mt-2 text-4xl font-extrabold tracking-tight">{t('docs.testing.title')}</h1>
        <p className="text-xl text-muted-foreground mt-4">
          <Trans i18nKey="docs.testing.subtitle" components={[<strong key="0" />]} />
        </p>
      </div>

      <h2>{t('docs.testing.setupTitle')}</h2>
      <p>
        {t('docs.testing.setupDesc', 'The testing module works completely locally, leveraging the Large Language Model to interpret code context and generate comprehensive unit tests.')}
      </p>

      <hr className="my-10 border-border" />

      <h2>{t('docs.testing.promptsTitle')}</h2>
      <p>
        {t('docs.testing.promptsDesc')}
      </p>

      <div className="space-y-6 mt-6">
        
        {/* Prompt 1 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-blue-500 m-0 mb-2">/create-unit-test</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.testing.prompts.p1Desc', 'Generate high-quality unit tests covering happy path, negative path, and edge cases with >80% coverage for any programming language.')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.testing.prompts.exampleUsage')}</span>
          <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
            /create-unit-test "Write unit tests for the login controller."
          </div>
        </div>

        {/* Prompt 2 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-blue-500 m-0 mb-2">/create-e2e-test</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.testing.prompts.p2Desc', 'Generates comprehensive, production-grade end-to-end (E2E) tests covering user flows, happy path, negative path, and UI stability.')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.testing.prompts.exampleUsage')}</span>
          <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
            /create-e2e-test "Write e2e tests for the user registration flow."
          </div>
        </div>

        {/* Prompt 3 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-blue-500 m-0 mb-2">/create-integration-test</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.testing.prompts.p3Desc', 'Generates integration tests leveraging real environments, API dependencies, and Testcontainers (e.g., MySQL, PostgreSQL) for robust verification.')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.testing.prompts.exampleUsage')}</span>
          <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
            /create-integration-test "Create integration tests for the PostgreSQL controller using Testcontainers."
          </div>
        </div>

      </div>
    </>
  )
}
