import { useTranslation, Trans } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

export function ProjectManagementDocs() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const version = searchParams.get('v') || '1.2.0'
  const showGithubIssue = version !== '1.1.3'

  return (
    <>
      <div className="mb-8">
        <span className="text-accent font-semibold tracking-wider text-sm uppercase">{t('docs.projectManagement.badge')}</span>
        <h1 className="mt-2 text-4xl font-extrabold tracking-tight">{t('docs.projectManagement.title')}</h1>
        <p className="text-xl text-muted-foreground mt-4">
          {showGithubIssue ? (
            <Trans i18nKey="docs.projectManagement.subtitleGithub" components={[<strong key="0" />]} />
          ) : (
            <Trans i18nKey="docs.projectManagement.subtitle" components={[<strong key="0" />]} />
          )}
        </p>
      </div>

      <h2>{t('docs.projectManagement.setupTitle')}</h2>
      <p>
        {t('docs.projectManagement.setupDesc')}
      </p>

      <div className="overflow-x-auto rounded-lg border border-border my-6 bg-card">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted">
            <tr className="border-b border-border">
              <th className="p-4 font-semibold text-foreground">{t('docs.projectManagement.table.platform')}</th>
              <th className="p-4 font-semibold text-foreground">{t('docs.projectManagement.table.variable')}</th>
              <th className="p-4 font-semibold text-foreground">{t('docs.projectManagement.table.description')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-xs md:text-sm text-foreground/80">
            <tr>
              <td className="p-4 font-semibold text-foreground">Jira</td>
              <td className="p-4 font-mono text-accent text-xs">JIRA_URL</td>
              <td className="p-4"><Trans i18nKey="docs.projectManagement.table.descJiraUrl" components={[<code key="0" className="text-xs bg-muted p-1 rounded font-mono" />]} /></td>
            </tr>
            <tr>
              <td className="p-4 border-r border-border/30 hidden md:table-cell"></td>
              <td className="p-4 font-mono text-accent text-xs">JIRA_EMAIL</td>
              <td className="p-4">{t('docs.projectManagement.table.descJiraEmail')}</td>
            </tr>
            <tr>
              <td className="p-4 border-r border-border/30 hidden md:table-cell"></td>
              <td className="p-4 font-mono text-accent text-xs">JIRA_API_TOKEN</td>
              <td className="p-4">{t('docs.projectManagement.table.descJiraToken')}</td>
            </tr>
            
            <tr className="border-t-[3px] border-border/60">
              <td className="p-4 font-semibold text-foreground">Trello</td>
              <td className="p-4 font-mono text-accent text-xs">TRELLO_API_KEY</td>
              <td className="p-4">{t('docs.projectManagement.table.descTrelloKey')}</td>
            </tr>
            <tr>
              <td className="p-4 border-r border-border/30 hidden md:table-cell"></td>
              <td className="p-4 font-mono text-accent text-xs">TRELLO_API_TOKEN</td>
              <td className="p-4">{t('docs.projectManagement.table.descTrelloToken')}</td>
            </tr>
            
            <tr className="border-t-[3px] border-border/60">
              <td className="p-4 font-semibold text-foreground">OpenProject</td>
              <td className="p-4 font-mono text-accent text-xs">OPENPROJECT_URL</td>
              <td className="p-4">{t('docs.projectManagement.table.descOpUrl')}</td>
            </tr>
            <tr>
              <td className="p-4 border-r border-border/30 hidden md:table-cell"></td>
              <td className="p-4 font-mono text-accent text-xs">OPENPROJECT_API_KEY</td>
              <td className="p-4">{t('docs.projectManagement.table.descOpKey')}</td>
            </tr>
            {showGithubIssue && (
              <tr className="border-t-[3px] border-border/60">
                <td className="p-4 font-semibold text-foreground">GitHub</td>
                <td className="p-4 font-mono text-accent text-xs">GITHUB_TOKEN</td>
                <td className="p-4">{t('docs.projectManagement.table.descGithubToken', 'GitHub Personal Access Token for fetching issues (or GITHUB_PERSONAL_ACCESS_TOKEN).')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <hr className="my-10 border-border" />

      <h2>{t('docs.projectManagement.toolsTitle')}</h2>
      <p>
        {t('docs.projectManagement.toolsDesc')}
      </p>

      <div className="space-y-6 mt-6">
        
        {/* Tool 1 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">get_jira_ticket</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">Jira</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.projectManagement.tools.t1Desc')}
          </p>
        </div>

        {/* Tool 2 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">get_trello_card</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">Trello</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.projectManagement.tools.t2Desc')}
          </p>
        </div>

        {/* Tool 3 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">get_openproject_work_package</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">OpenProject</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.projectManagement.tools.t3Desc')}
          </p>
        </div>

        {/* Tool 4 */}
        {showGithubIssue && (
          <div className="p-5 border border-border rounded-xl bg-card">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
              <h3 className="font-mono text-base md:text-lg text-accent m-0">get_github_issue</h3>
              <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">GitHub</span>
            </div>
            <p className="text-xs md:text-sm text-muted-foreground m-0">
              {t('docs.projectManagement.tools.t4Desc', 'Fetch a GitHub issue with complete context including comments, labels, milestones, and linked PRs.')}
            </p>
          </div>
        )}

        {/* Tool 5 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">create_jira_ticket</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">Jira</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.projectManagement.tools.t5Desc', 'Creates a new Jira issue with labels, priority, and attachments.')}
          </p>
        </div>

        {/* Tool 6 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">create_trello_card</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">Trello</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.projectManagement.tools.t6Desc', 'Creates a new Trello card in a specific list.')}
          </p>
        </div>

        {/* Tool 7 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">create_openproject_work_package</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">OpenProject</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.projectManagement.tools.t7Desc', 'Creates a new OpenProject work package with assignee and priority.')}
          </p>
        </div>

        {/* Tool 8 */}
        {showGithubIssue && (
          <div className="p-5 border border-border rounded-xl bg-card">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
              <h3 className="font-mono text-base md:text-lg text-accent m-0">create_github_issue</h3>
              <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">GitHub</span>
            </div>
            <p className="text-xs md:text-sm text-muted-foreground m-0">
              {t('docs.projectManagement.tools.t8Desc', 'Creates a new GitHub issue with labels, milestone, and assignees.')}
            </p>
          </div>
        )}

        {/* Tool 9 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">get_jira_ticket_comments</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">Jira</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.projectManagement.tools.t9Desc', 'Fetches comment threads and activity history for a specific Jira ticket.')}
          </p>
        </div>

        {/* Tool 10 */}
        <div className="p-5 border border-border rounded-xl bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h3 className="font-mono text-base md:text-lg text-accent m-0">get_openproject_work_package_comments</h3>
            <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-muted border border-border self-start sm:self-auto">OpenProject</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground m-0">
            {t('docs.projectManagement.tools.t10Desc', 'Fetches comment threads and activity history for a specific OpenProject work package.')}
          </p>
        </div>

      </div>

      <hr className="my-10 border-border" />

      <h2>{t('docs.projectManagement.promptsTitle')}</h2>
      <p>
        {t('docs.projectManagement.promptsDesc')}
      </p>

      <div className="space-y-6 mt-6">
        
        {/* Prompt 1 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-emerald-500 m-0 mb-2">/pm_summarize_ticket</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.projectManagement.prompts.p1Desc')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.projectManagement.prompts.exampleUsage')}</span>
          <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
            /pm_summarize_ticket "{t('docs.projectManagement.prompts.p1Query')}"
          </div>
        </div>

        {/* Prompt 2 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-emerald-500 m-0 mb-2">/pm_brainstorm_plan</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.projectManagement.prompts.p2Desc')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.projectManagement.prompts.exampleUsage')}</span>
          <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
            /pm_brainstorm_plan "{t('docs.projectManagement.prompts.p2Query')}"
          </div>
        </div>

        {/* Prompt 3 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-emerald-500 m-0 mb-2">/pm_test_catalog</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.projectManagement.prompts.p3Desc')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.projectManagement.prompts.exampleUsage')}</span>
          <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
            /pm_test_catalog "{t('docs.projectManagement.prompts.p3Query')}"
          </div>
        </div>

        {/* Prompt 4 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-emerald-500 m-0 mb-2">/pm_create_ticket</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.projectManagement.prompts.p4Desc', 'Digest raw feature requests and structure them into Big Tech-standard tickets.')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.projectManagement.prompts.exampleUsage')}</span>
          <div className="flex flex-col gap-2">
            <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
              /pm_create_ticket "{t('docs.projectManagement.prompts.p4QueryJira', 'Create a bug ticket for login page in Jira.')}"
            </div>
            <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
              /pm_create_ticket "{t('docs.projectManagement.prompts.p4QueryTrello', 'Create a card in Trello todo list about registration form.')}"
            </div>
            <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
              /pm_create_ticket "{t('docs.projectManagement.prompts.p4QueryOpenProject', 'Create a task in OpenProject for setting up database.')}"
            </div>
            <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
              /pm_create_ticket "{t('docs.projectManagement.prompts.p4QueryGithub', 'Create a github issue about fixing the memory leak.')}"
            </div>
          </div>
        </div>

        {/* Prompt 5 */}
        <div className="p-6 border border-border rounded-xl bg-card">
          <h3 className="font-mono text-lg text-emerald-500 m-0 mb-2">/dev_check_comment</h3>
          <p className="text-xs md:text-sm text-muted-foreground mb-4">
            {t('docs.projectManagement.prompts.p5Desc', 'Analyze comments, activity logs, and reviewer feedback on tickets (Jira, OpenProject, GitHub, Trello) as a Senior Software Developer.')}
          </p>
          <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-2">{t('docs.projectManagement.prompts.exampleUsage')}</span>
          <div className="bg-muted p-3 rounded-lg font-mono text-sm border border-border/50 text-foreground overflow-x-auto">
            /dev_check_comment "{t('docs.projectManagement.prompts.p5Query', 'Review comments and discussions on Jira ticket PRJ-100.')}"
          </div>
        </div>

      </div>
    </>
  )
}
