import { useEffect, useState } from "react"
import { Link, Outlet, useLocation, useSearchParams } from "react-router-dom"
import { motion } from "framer-motion"
import { Search, ChevronDown, Sun, Moon, Home, BookOpen, Menu, X } from "lucide-react"
import pkg from "../../../../package.json"
import { Footer } from "../landing/Footer"
import { LanguageSwitcher } from "../ui/LanguageSwitcher"
import { LuminaLogo } from "../ui/LuminaLogo"
import { useTranslation } from "react-i18next"

interface TOCItem {
  id: string
  text: string
  level: number
}

const SECTIONS = [
  {
    title: "Getting Started",
    items: [
      { name: "Getting Started", path: "/docs/getting-started", keywords: "start introduction install setup config credentials guide" },
      { name: "Compound Engineering", path: "/docs/compound-engineering", keywords: "compound plugin agent local tools CLI fallback fallback-work" }
    ]
  },
  {
    title: "Core Integrations",
    items: [
      { name: "Database Integration", path: "/docs/database", keywords: "database postgres mysql sql query list tables schema inspect explain audit explain" },
      { name: "Project Management", path: "/docs/project-management", keywords: "jira trello openproject tickets import task epic board kanban" },
      { name: "Version Control", path: "/docs/version-control", keywords: "git commit pr github branch review comments resolve diff pull request" },
      { name: "Testing", path: "/docs/testing", keywords: "test testing unit test sdet happy path negative path edge cases code coverage mock" }
    ]
  },
  {
    title: "AI Orchestration",
    items: [
      { name: "AI Orchestration", path: "/docs/orchestration", keywords: "orchestration phases lifecycle brainstorm planning execution work code review compound fallback" }
    ]
  }
]

export function DocsLayout() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const [toc, setToc] = useState<TOCItem[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    "Getting Started": true,
    "Core Integrations": true,
    "AI Orchestration": true
  })
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const currentVersion = searchParams.get("v") || pkg.version
  const [isVersionMenuOpen, setIsVersionMenuOpen] = useState(false)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.version-dropdown-container')) {
        setIsVersionMenuOpen(false)
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [])

  useEffect(() => {
    setIsMobileMenuOpen(false)
  }, [pathname])

  // Theme support
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme")
    if (saved === "light" || saved === "dark") return saved
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  })

  useEffect(() => {
    const root = document.documentElement
    if (theme === "dark") {
      root.classList.add("dark")
    } else {
      root.classList.remove("dark")
    }
    localStorage.setItem("theme", theme)
  }, [theme])

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"))
  }

  // Basic TOC generator: scans DOM for h2/h3 inside the <main> tag
  useEffect(() => {
    const timer = setTimeout(() => {
      const headings = Array.from(document.querySelectorAll("main h2, main h3"))
      const newToc = headings.map(heading => {
        if (!heading.id) {
          // Sanitize textContent to prevent DOM XSS vulnerabilities (CWE-79 / CWE-116)
          const safeText = heading.textContent?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || ""
          heading.id = safeText
        }
        return {
          id: heading.id,
          text: heading.textContent || "",
          level: heading.tagName.toLowerCase() === "h2" ? 2 : 3
        }
      })
      setToc(newToc)
    }, 120)

    return () => clearTimeout(timer)
  }, [pathname])

  const toggleSection = (title: string) => {
    setExpandedSections(prev => ({
      ...prev,
      [title]: !prev[title]
    }))
  }

  // Filter sections by search query
  const filteredSections = SECTIONS.map(section => {
    const matchedItems = section.items.filter(item => 
      item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.keywords.toLowerCase().includes(searchQuery.toLowerCase())
    )
    return {
      ...section,
      items: matchedItems
    }
  }).filter(section => section.items.length > 0)

  const getPathWithVersion = (path: string) => {
    if (currentVersion && currentVersion !== pkg.version) {
      return `${path}?v=${currentVersion}`
    }
    return path
  }

  return (
    <div className="min-h-screen bg-background text-foreground transition-colors flex flex-col">
      
      {/* Sticky header */}
      <nav className="w-full border-b border-border/40 bg-background/80 backdrop-blur-md sticky top-0 z-50 transition-colors">
        <div className="max-w-[1400px] mx-auto px-6 h-16 flex justify-between items-center relative">
          
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-2 group shrink-0">
              <LuminaLogo size={28} showText={false} />
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="text-lg font-extrabold tracking-tighter text-foreground">Lumina<span className="text-accent">MCP</span></span>
                <span className="text-muted-foreground font-normal text-xs border-l border-border/60 pl-2 h-4 flex items-center">Docs</span>
              </span>
            </Link>

            {/* Version Dropdown */}
            <div className="relative version-dropdown-container hidden sm:block">
              <div 
                onClick={() => setIsVersionMenuOpen(!isVersionMenuOpen)}
                className="flex items-center gap-2 bg-muted/30 border border-border/60 rounded-md px-2.5 py-1.5 transition-colors hover:bg-muted/50 cursor-pointer group"
              >
                <span className="text-xs font-semibold tracking-wide text-muted-foreground group-hover:text-foreground transition-colors">v{currentVersion}</span>
                {currentVersion === pkg.version && (
                  <span className="px-1.5 py-0.5 rounded-sm bg-accent/10 text-accent border border-accent/20 text-[9px] font-extrabold uppercase tracking-wider">
                    Latest
                  </span>
                )}
                <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground ml-1 transition-transform ${isVersionMenuOpen ? 'rotate-180' : ''}`} />
              </div>
              
              {isVersionMenuOpen && (
                <div className="absolute top-full mt-1.5 left-0 bg-background border border-border/60 shadow-xl rounded-md overflow-hidden z-50 w-36 flex flex-col">
                  <button 
                    onClick={() => {
                      setSearchParams((prev) => {
                        const newParams = new URLSearchParams(prev)
                        newParams.delete('v')
                        return newParams
                      })
                      setIsVersionMenuOpen(false)
                    }}
                    className={`text-left px-3 py-2 text-xs hover:bg-muted/50 transition-colors ${currentVersion === pkg.version ? 'font-bold text-accent bg-accent/5' : 'text-foreground'}`}
                  >
                    v{pkg.version} (Latest)
                  </button>
                </div>
              )}
            </div>

            <LanguageSwitcher />
          </div>

          {/* Desktop Links */}
          <div className="hidden md:flex gap-6 items-center">
            <Link to="/" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
              <Home className="h-4 w-4" /> {t('docsLayout.home')}
            </Link>
            <a href="https://github.com/Wahyu-Labs/lumina-mcp" target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              {t('docsLayout.github')}
            </a>
            
            <div className="h-4 w-px bg-border/60" />

            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-lg border border-border/60 hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>

          {/* Mobile menu trigger + theme toggle */}
          <div className="flex md:hidden items-center gap-2">
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-lg border border-border/60 hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="p-1.5 rounded-lg border border-border/60 hover:bg-muted/50 transition-colors text-foreground"
              aria-label="Toggle mobile menu"
            >
              {isMobileMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Mobile Menu Dropdown */}
        {isMobileMenuOpen && (
          <div className="md:hidden absolute top-16 left-0 w-full bg-background border-b border-border/40 shadow-xl px-6 py-6 flex flex-col gap-6 z-40 max-h-[calc(100vh-4rem)] overflow-y-auto transition-colors">
            
            {/* Search bar inside mobile menu */}
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder={t('docsLayout.searchDocs')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 text-xs rounded-lg border border-border/60 bg-muted/30 focus:bg-background focus:ring-1 focus:ring-accent focus:outline-none transition-all placeholder:text-muted-foreground"
              />
            </div>

            <div className="flex flex-col gap-4">
              <Link 
                to="/" 
                onClick={() => setIsMobileMenuOpen(false)}
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
              >
                <Home className="h-4 w-4" /> {t('docsLayout.home')}
              </Link>
              <a 
                href="https://github.com/Wahyu-Labs/lumina-mcp" 
                target="_blank" 
                rel="noopener noreferrer" 
                onClick={() => setIsMobileMenuOpen(false)}
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
              >
                {t('docsLayout.github')}
              </a>
            </div>

            <div className="h-px w-full bg-border/60" />

            {/* Collapsible Sections (Sidebar contents for mobile) */}
            <div className="space-y-6">
              <div className="text-xs uppercase font-extrabold text-muted-foreground tracking-wider mb-2">
                {t('docsLayout.documentation')}
              </div>
              {filteredSections.map(section => (
                <div key={section.title} className="space-y-2">
                  <div className="text-xs font-bold text-muted-foreground/80">
                    {t(`docsLayout.sections.${section.title}`)}
                  </div>
                  <ul className="space-y-1.5 pl-1.5 border-l border-border/40">
                    {section.items.map(item => {
                      const isActive = pathname === item.path
                      return (
                        <li key={item.name}>
                          <Link
                            to={getPathWithVersion(item.path)}
                            onClick={() => setIsMobileMenuOpen(false)}
                            className={`block py-1 px-2.5 text-xs rounded-md transition-all ${
                              isActive
                                ? "bg-accent/10 text-accent font-bold"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                            }`}
                          >
                            {t(`docsLayout.sections.${item.name}`)}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>

          </div>
        )}
      </nav>

      {/* Grid Container */}
      <div className="max-w-[1400px] mx-auto w-full flex-grow flex">
        
        {/* Left Sidebar */}
        <aside className="hidden md:block w-72 flex-shrink-0 border-r border-border/40 py-8 px-6 sticky top-16 h-[calc(100vh-4rem)] overflow-y-auto bg-background transition-colors">
          
          {/* Search bar */}
          <div className="relative mb-6">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder={t('docsLayout.searchDocs')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-xs rounded-lg border border-border/60 bg-muted/30 focus:bg-background focus:ring-1 focus:ring-accent focus:outline-none transition-all placeholder:text-muted-foreground"
            />
          </div>

          {/* Navigation Sections */}
          <div className="space-y-6">
            {filteredSections.map(section => (
              <div key={section.title} className="space-y-2">
                
                {/* Collapsible Section Header */}
                <button
                  onClick={() => toggleSection(section.title)}
                  className="w-full flex items-center justify-between text-xs uppercase font-extrabold text-muted-foreground hover:text-foreground transition-colors py-1 text-left tracking-wider"
                >
                  <span>{t(`docsLayout.sections.${section.title}`)}</span>
                  <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${
                    expandedSections[section.title] ? "" : "-rotate-90"
                  }`} />
                </button>

                {/* Collapsible List items */}
                {expandedSections[section.title] && (
                  <ul className="space-y-1.5 pl-1.5 border-l border-border/40">
                    {section.items.map(item => {
                      const isActive = pathname === item.path
                      return (
                        <li key={item.name}>
                          <Link
                            to={getPathWithVersion(item.path)}
                            className={`block py-1 px-2.5 text-xs rounded-md transition-all ${
                              isActive
                                ? "bg-accent/10 text-accent font-bold"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                            }`}
                          >
                            {t(`docsLayout.sections.${item.name}`)}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                )}

              </div>
            ))}
          </div>

        </aside>

        {/* Center Content Area */}
        <main className="flex-grow max-w-3xl px-6 py-10 md:px-12 w-full prose prose-zinc dark:prose-invert prose-headings:scroll-mt-24 pb-32">
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
          >
            <Outlet />
          </motion.div>
        </main>

        {/* Right Sidebar (Table of Contents) */}
        <aside className="hidden lg:block w-64 flex-shrink-0 py-8 px-6 sticky top-16 h-[calc(100vh-4rem)] overflow-y-auto bg-background transition-colors">
          {toc.length > 0 && (
            <div className="space-y-4">
              <h4 className="font-extrabold text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <BookOpen className="h-3.5 w-3.5" /> {t('docsLayout.onThisPage')}
              </h4>
              <ul className="space-y-2 border-l border-border/40 pl-2">
                {toc.map(item => (
                  <li key={item.id} className={`${item.level === 3 ? "ml-4" : ""}`}>
                    <a
                      href={`#${item.id}`}
                      onClick={(e) => {
                        e.preventDefault()
                        const element = document.getElementById(item.id)
                        if (element) {
                          const yOffset = -80 // Offset for sticky navbar
                          const y = element.getBoundingClientRect().top + window.scrollY + yOffset
                          window.scrollTo({ top: y, behavior: 'smooth' })
                          window.history.pushState(null, '', `#${item.id}`)
                        }
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors line-clamp-2 leading-relaxed"
                    >
                      {item.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

      </div>

      <Footer />
    </div>
  )
}
