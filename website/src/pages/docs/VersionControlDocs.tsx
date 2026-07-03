import { useTranslation, Trans } from 'react-i18next'

export function VersionControlDocs() {
  const { t } = useTranslation()
  return (
    <>
      <div className="mb-8">
        <span className="text-accent font-semibold tracking-wider text-sm uppercase">{t('docs.versionControl.badge')}</span>
        <h1 className="mt-2 text-4xl font-extrabold tracking-tight">{t('docs.versionControl.title')}</h1>
        <p className="text-xl text-muted-foreground mt-4">
          {t('docs.versionControl.subtitle')}
        </p>
      </div>

      <h2>{t('docs.versionControl.setupTitle')}</h2>
      <p>
        {t('docs.versionControl.setupDesc')}
      </p>

      <div className="overflow-x-auto rounded-lg border border-border my-6 bg-card">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted">
            <tr className="border-b border-border">
              <th className="p-4 font-semibold text-foreground">{t('docs.versionControl.table.variable')}</th>
              <th className="p-4 font-semibold text-foreground">{t('docs.versionControl.table.description')}</th>
              <th className="p-4 font-semibold text-foreground">{t('docs.versionControl.table.example')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-xs md:text-sm text-foreground/80">
            <tr>
              <td className="p-4 font-mono text-accent">GITHUB_TOKEN</td>
              <td className="p-4"><Trans i18nKey="docs.versionControl.table.descToken" components={[<code key="0" />]} /></td>
              <td className="p-4"><code className="text-xs bg-muted p-1 rounded font-mono">github_pat_11A2B3C4D...</code></td>
            </tr>
            <tr>
              <td className="p-4 font-mono text-accent">GITEA_TOKEN</td>
              <td className="p-4"><Trans i18nKey="docs.versionControl.table.descGiteaToken" defaults="Personal Access Token for your Gitea server." /></td>
              <td className="p-4"><code className="text-xs bg-muted p-1 rounded font-mono">1a2b3c4d5e...</code></td>
            </tr>
            <tr>
              <td className="p-4 font-mono text-accent">GITEA_URL</td>
              <td className="p-4"><Trans i18nKey="docs.versionControl.table.descGiteaUrl" defaults="The base URL of your Gitea instance." /></td>
              <td className="p-4"><code className="text-xs bg-muted p-1 rounded font-mono">https://gitea.example.com</code></td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="my-10 border-border" />

      <h2>{t('docs.versionControl.toolsTitle')}</h2>
      <p>
        {t('docs.versionControl.toolsDesc')}
      </p>

      <div className="space-y-6 mt-6">
        
        {/* Tool 1 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">generate_commit_and_push</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">{t('docs.versionControl.tools.t1Badge')}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.versionControl.tools.t1Desc')}
          </p>
        </div>

        {/* Tool 2 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">create_github_pr</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">{t('docs.versionControl.tools.t2Badge')}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.versionControl.tools.t2Desc')}
          </p>
        </div>

        {/* Tool 3 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">review_github_pr</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">{t('docs.versionControl.tools.t3Badge')}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.versionControl.tools.t3Desc')}
          </p>
        </div>

        {/* Tool 4 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">fix_github_pr_review</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">{t('docs.versionControl.tools.t4Badge')}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.versionControl.tools.t4Desc')}
          </p>
        </div>

        {/* Tool 5 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">get_github_pr_diff</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">{t('docs.versionControl.tools.t5Badge')}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.versionControl.tools.t5Desc')}
          </p>
        </div>

        {/* Tool 6 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">reply_to_pr_comment</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">{t('docs.versionControl.tools.t6Badge')}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.versionControl.tools.t6Desc')}
          </p>
        </div>

        {/* Tool 7 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">resolve_pr_review_thread</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">{t('docs.versionControl.tools.t7Badge')}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.versionControl.tools.t7Desc')}
          </p>
        </div>

        {/* Tool 8 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">create_gitea_pr</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">{t('docs.versionControl.tools.t8Badge', 'GITEA')}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.versionControl.tools.t8Desc', 'Opens a new Gitea Pull Request with a value-first markdown description outlining the modifications.')}
          </p>
        </div>

        {/* Tool 9 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">review_gitea_pr</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">{t('docs.versionControl.tools.t9Badge', 'GITEA')}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.versionControl.tools.t9Desc', 'Submits an AI-based code review to a Gitea Pull Request (approve, request changes, or comment).')}
          </p>
        </div>

        {/* Tool 10 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">fix_gitea_pr_review</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">{t('docs.versionControl.tools.t10Badge', 'GITEA')}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.versionControl.tools.t10Desc', 'Automatically fixes code review feedback on a Gitea Pull Request.')}
          </p>
        </div>

        {/* Tool 11 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">get_gitea_pr_diff</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">{t('docs.versionControl.tools.t11Badge', 'GITEA')}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.versionControl.tools.t11Desc', 'Downloads a clean, unified git diff representation of any open Gitea pull request for automated review.')}
          </p>
        </div>

      </div>

      <hr className="my-10 border-border" />

      <h2>{t('docs.versionControl.promptsTitle')}</h2>
      <p>
        {t('docs.versionControl.promptsDesc')}
      </p>

      <div className="space-y-6 mt-6">
        
        {/* Prompt 1 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-purple-500 m-0 mb-2">/commit_generator_message</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.versionControl.prompts.p1Desc')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.versionControl.prompts.exampleUsage')}</span>
          <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
            /commit_generator_message "{t('docs.versionControl.prompts.p1Query')}"
          </div>
        </div>

        {/* Prompt 2 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-purple-500 m-0 mb-2">/tech_company_pr_creator</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.versionControl.prompts.p2Desc')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.versionControl.prompts.exampleUsage')}</span>
          <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
            /tech_company_pr_creator "{t('docs.versionControl.prompts.p2Query')}"
          </div>
        </div>

        {/* Prompt 3 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-purple-500 m-0 mb-2">/ai_code_reviewer</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.versionControl.prompts.p3Desc')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.versionControl.prompts.exampleUsage')}</span>
          <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
            /ai_code_reviewer "{t('docs.versionControl.prompts.p3Query')}"
          </div>
        </div>

        {/* Prompt 4 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-purple-500 m-0 mb-2">/fix_pr_review_message</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.versionControl.prompts.p4Desc')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.versionControl.prompts.exampleUsage')}</span>
          <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
            /fix_pr_review_message "{t('docs.versionControl.prompts.p4Query')}"
          </div>
        </div>

      </div>
    </>
  )
}
