import { useState } from "react"
import { GitPullRequest, Code2, Command, MessageSquare, ArrowRight, Copy, Check } from "lucide-react"
import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"

// GIT_PROMPTS will be generated in the component to access translations

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button 
      onClick={handleCopy} 
      className="p-1.5 rounded-md bg-background border border-border/40 hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-all ml-auto shrink-0 shadow-sm"
      title="Copy prompt"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

export function GitSection() {
  const { t } = useTranslation();

  const GIT_PROMPTS = [
    {
      name: "/commit_generator_message",
      desc: t('git.prompts.commit'),
      cmd: '/commit_generator_message "Stage my changes and run commit push."'
    },
    {
      name: "/tech_company_pr_creator",
      desc: t('git.prompts.pr'),
      cmd: '/tech_company_pr_creator "Create a PR into main for the branch feat/readonly."'
    },
    {
      name: "/ai_code_reviewer",
      desc: t('git.prompts.review'),
      cmd: '/ai_code_reviewer "Review PR #42 and approve it."'
    },
    {
      name: "/fix_pr_review_message",
      desc: t('git.prompts.fix'),
      cmd: '/fix_pr_review_message "Resolve PR comments on #104."'
    },
    {
      name: "/create_gitea_pr",
      desc: t('git.prompts.giteaPr', 'Opens a new Gitea Pull Request.'),
      cmd: '/create_gitea_pr "Create a Gitea PR into main from the current branch."'
    }
  ]

  return (
    <section className="py-24 bg-muted/20 transition-colors w-full border-b border-border/40" id="git">
      <div className="max-w-7xl mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-start">
          
          {/* Left Column: Info & Action */}
          <div className="flex flex-col items-start text-left lg:sticky lg:top-24">
            <div className="h-12 w-12 rounded-2xl bg-purple-500/10 text-purple-500 flex items-center justify-center mb-6">
              <GitPullRequest className="h-6 w-6" />
            </div>
            <h2 className="text-3xl md:text-5xl font-black tracking-tight text-foreground mb-6">
              {t('git.title')}
            </h2>
            <p className="text-muted-foreground text-base md:text-lg leading-relaxed mb-8 max-w-lg">
              {t('git.subtitle')}
            </p>

            {/* Comment Loop Note */}
            <div className="p-5 rounded-2xl border border-purple-500/20 bg-purple-500/5 flex items-start gap-4 mb-10 w-full">
              <MessageSquare className="h-6 w-6 text-purple-500 mt-0.5 shrink-0" />
              <div>
                <h4 className="font-bold text-foreground text-sm m-0">{t('git.recursiveResolution')}</h4>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed m-0">
                  {t('git.recursiveResolutionDesc')}
                </p>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-row flex-wrap gap-3">
              <Link
                to="/docs/git"
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-foreground text-background text-xs font-bold shadow-md hover:scale-[1.02] hover:bg-foreground/95 active:scale-[0.98] transition-all duration-200"
              >
                {t('git.docs')} <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>

          {/* Right Column: Prompts List */}
          <div className="flex flex-col gap-4">
            {GIT_PROMPTS.map((tool, idx) => (
              <div key={idx} className="p-6 rounded-2xl border border-border bg-card/60 backdrop-blur-sm flex flex-col gap-4 transition-all hover:bg-card/80 hover:shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500 shrink-0 mt-0.5">
                    <Code2 className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h3 className="font-mono text-sm font-bold text-foreground m-0">{tool.name}</h3>
                    <p className="text-xs md:text-sm text-muted-foreground mt-2 leading-relaxed m-0">{tool.desc}</p>
                  </div>
                </div>

                <div className="pt-3 border-t border-border/40 text-xs flex flex-col gap-3">
                  <span className="text-[10px] uppercase font-extrabold text-muted-foreground tracking-wider block mb-1">{t('git.examplePrompt')}</span>
                  <div className="font-mono bg-muted/80 p-2 pl-3 rounded-lg flex items-center gap-3 text-accent border border-border/60 overflow-hidden relative group">
                    <Command className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="overflow-x-auto whitespace-nowrap scrollbar-hide py-1 mr-8">{tool.cmd}</span>
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <CopyButton text={tool.cmd} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

        </div>
      </div>
    </section>
  )
}
