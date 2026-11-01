// Executive Blue: an adapted, self-contained theme (no @preview packages).
// Page 1: gradient header band, summary + sidebar (contact, skills) and a
// boxed current role. Later pages: running header and an experience timeline.

#let source = json(__RESUME_DATA_PATH__)

// ---- palette -------------------------------------------------------------
#let navy = rgb("#1e3a8f")
#let blue = rgb("#3b82f6")
#let rule-blue = rgb("#dbe7fb")
#let panel-blue = rgb("#dbe8fd")
#let panel-grey = rgb("#f3f5f9")
#let ink = rgb("#1f2937")
#let muted = rgb("#4b5563")
#let faint = rgb("#9ca3af")

#let sans = ("Liberation Sans", "Arimo", "Arial", "Helvetica Neue", "Helvetica", "Libertinus Serif")

// ---- data helpers --------------------------------------------------------
#let with-default(value, fallback) = if value == none { fallback } else { value }
#let text-of(value) = with-default(value, "")
#let list-of(value) = with-default(value, ())
#let item-text(item, key) = text-of(item.at(key, default: ""))

#let markup-text(val) = if type(val) == str { eval(val, mode: "markup") } else { val }

#let link-or-text(label, url) = if url == "" { label } else { link(url)[#label] }

#let bullets-of(entry) = {
  list-of(entry.at("bullets", default: ()))
    .map(item => text-of(item))
    .filter(item => item != "")
    .map(item => markup-text(item))
}

#let contact-items = list-of(source.at("contactItems", default: ()))
#let profile-items = list-of(source.at("profileItems", default: ()))
#let custom-field-items = list-of(source.at("customFieldItems", default: ()))
#let section-titles = with-default(source.at("sectionTitles", default: (:)), (:))
#let title-for(key, fallback) = {
  let t = text-of(section-titles.at(key, default: ""))
  if t == "" { fallback } else { t }
}

#let name = text-of(source.at("name", default: ""))
#let headline = text-of(source.at("headline", default: ""))
#let location = text-of(source.at("location", default: ""))
#let summary = text-of(source.at("summary", default: ""))
#let experience = list-of(source.at("experience", default: ()))
#let skill-groups = list-of(source.at("skillGroups", default: ()))

#let picture = with-default(source.at("picture", default: (:)), (:))
#let picture-path = text-of(picture.at("renderPath", default: ""))
#let picture-hidden = with-default(picture.at("hidden", default: true), true)

// ---- page setup ----------------------------------------------------------
#let page-margin = 1.5cm
#let band-height = 2.9cm

#set page(
  paper: __PAGE_PAPER__,
  margin: (x: page-margin, top: page-margin, bottom: 1.3cm),
  header: context {
    if counter(page).get().first() > 1 {
      set text(font: sans, size: 11pt, weight: "bold", fill: navy)
      grid(
        columns: (1fr, auto),
        upper(name),
        text(size: 8.5pt, weight: "regular", fill: muted)[Page #counter(page).display()],
      )
      v(-4pt)
      line(length: 100%, stroke: 1.2pt + rule-blue)
    }
  },
  header-ascent: 35%,
)
#set text(font: sans, size: 9pt, fill: ink, lang: "en")
#set par(leading: 0.5em, spacing: 1em)
#show link: set text(fill: navy)
#set list(marker: text(fill: blue, size: 0.9em)[→], body-indent: 0.55em, spacing: 0.55em, indent: 0pt)

// ---- building blocks -----------------------------------------------------
#let section-heading(title) = [
  #v(0.9em, weak: true)
  #text(size: 11.5pt, weight: "bold", fill: navy)[#upper(title)]
  #v(-0.5em)
  #line(length: 100%, stroke: 1.2pt + rule-blue)
  #v(0.35em)
]

#let sub-heading(title) = text(size: 9.5pt, weight: "bold", fill: navy)[#upper(title)]

#let grey-box(title, body) = block(
  width: 100%,
  fill: panel-grey,
  inset: 10pt,
  radius: 3pt,
  breakable: false,
)[
  #sub-heading(title)
  #v(0.15em)
  #body
]

#let initial-dot(letter) = box(
  width: 13pt, height: 13pt, radius: 50%, fill: navy, baseline: 3pt,
)[#align(center + horizon)[#text(fill: white, size: 6.5pt, weight: "bold")[#letter]]]

#let contact-row(item) = {
  let label = item-text(item, "text")
  let url = item-text(item, "url")
  let is-mail = label.contains("@") or url.starts-with("mailto:")
  grid(
    columns: (auto, 1fr),
    column-gutter: 7pt,
    initial-dot(if is-mail { "E" } else if url == "" { "P" } else { "W" }),
    align(horizon, text(size: 9pt, fill: ink)[#link-or-text(label, url)]),
  )
}

#let timeline-entry(entry) = block(width: 100%, breakable: false, above: 1.1em, below: 0pt)[
  #place(left + top, dx: -17pt, dy: 1pt, circle(radius: 4pt, fill: blue))
  #grid(
    columns: (1fr, auto),
    column-gutter: 1em,
    text(size: 10pt, weight: "bold", fill: navy)[#link-or-text(item-text(entry, "title"), item-text(entry, "url"))],
    text(size: 8.5pt, fill: blue)[#item-text(entry, "date")],
  )
  #{
    let role = item-text(entry, "subtitle")
    let place-name = item-text(entry, "secondarySubtitle")
    let line = (role, place-name).filter(s => s != "").join(" · ")
    if line != "" { text(size: 8.8pt, style: "italic", fill: ink)[#line] }
  }
  #v(0.2em)
  #set text(size: 8.4pt)
  #set list(spacing: 0.45em)
  #let bullets = bullets-of(entry)
  #if bullets.len() > 0 { list(..bullets) }
]

#let timeline(entries) = block(
  width: 100%,
  stroke: (left: 1.6pt + rgb("#d5d9e0")),
  inset: (left: 14pt, y: 2pt),
  outset: (left: 0pt),
  {
    for e in entries { timeline-entry(e) }
  },
)

#let current-role-box(entry) = block(
  width: 100%,
  fill: panel-blue,
  stroke: (left: 3pt + navy),
  inset: (x: 12pt, y: 10pt),
  radius: (right: 3pt),
  breakable: false,
)[
  #text(size: 12pt, weight: "bold", fill: navy)[#link-or-text(item-text(entry, "title"), item-text(entry, "url"))]
  #h(1fr)
  #text(size: 8.5pt, fill: blue)[#item-text(entry, "date")]
  #linebreak()
  #{
    let role = item-text(entry, "subtitle")
    let place-name = item-text(entry, "secondarySubtitle")
    let line = (role, place-name).filter(s => s != "").join(" · ")
    if line != "" { text(size: 9pt, weight: "bold")[#line] }
  }
  #v(0.3em)
  #set text(size: 8.6pt)
  #set list(spacing: 0.6em)
  #let bullets = bullets-of(entry)
  #if bullets.len() > 0 {
    let half = calc.ceil(bullets.len() / 2)
    grid(
      columns: (1fr, 1fr),
      column-gutter: 16pt,
      list(..bullets.slice(0, half)),
      if bullets.len() > half { list(..bullets.slice(half)) } else { [] },
    )
  }
]

#let is-current(entry) = {
  let d = lower(item-text(entry, "date"))
  d.contains("present") or d.contains("current")
}


// ---- custom sections -----------------------------------------------------
#let custom-sections = list-of(source.at("customSections", default: ()))
#let title-matches(section, pattern) = item-text(section, "title").match(regex(pattern)) != none
#let is-competencies(section) = title-matches(section, "(?i)competenc")
#let is-impact(section) = title-matches(section, "(?i)impact|transformation")
#let is-callout(section) = title-matches(section, "(?i)journey|career summary")
#let competency-sections = custom-sections.filter(is-competencies)
#let impact-sections = custom-sections.filter(is-impact)
#let callout-sections = custom-sections.filter(is-callout)
#let other-sections = custom-sections.filter(s => not is-competencies(s) and not is-impact(s) and not is-callout(s))

// One entry as a single line of text: "Title — bullet text".
#let entry-inline(entry) = {
  let title = item-text(entry, "title")
  let sub = item-text(entry, "subtitle")
  let body = bullets-of(entry).join(" ")
  let head = if title != "" and sub != "" { title + " — " + sub } else { title + sub }
  if head != "" and body != [] and body != "" [#head — #body] else if head != "" [#head] else [#body]
}

#let competency-list(section) = {
  set text(size: 8.8pt)
  set list(spacing: 0.5em)
  list(..list-of(section.at("entries", default: ())).map(entry-inline))
}

#let impact-strip(section) = {
  let items = list-of(section.at("entries", default: ())).map(entry-inline)
  block(width: 100%, fill: panel-grey, inset: (x: 12pt, y: 10pt), radius: 3pt, breakable: false)[
    #text(size: 10pt, weight: "bold", fill: navy)[#upper(item-text(section, "title"))]
    #v(0.35em)
    #set text(size: 8.6pt, fill: muted)
    #grid(
      columns: (1fr, 1fr, 1fr),
      column-gutter: 12pt,
      row-gutter: 0.6em,
      ..items.map(i => [#text(fill: blue, size: 7pt)[▸] #h(3pt) #i]),
    )
  ]
}

#let callout-panel(section) = block(
  width: 100%, fill: panel-blue, stroke: (left: 3pt + navy),
  inset: (x: 12pt, y: 10pt), radius: (right: 3pt), breakable: false,
)[
  #text(size: 9.5pt, weight: "bold", fill: navy)[#item-text(section, "title")]
  #v(0.3em)
  #set text(size: 8.8pt)
  #list-of(section.at("entries", default: ())).map(entry-inline).join(parbreak())
]

#let custom-box(section) = grey-box(
  item-text(section, "title"),
  {
    set text(size: 8.6pt)
    for entry in list-of(section.at("entries", default: ())) {
      block(below: 0.45em)[#entry-inline(entry)]
    }
  },
)

// ---- header band (page 1 only, full bleed) -------------------------------
#context {
  let w = page.width
  place(top + left, dx: -page-margin, dy: -page-margin, rect(
    width: w,
    height: band-height,
    fill: gradient.linear(rgb("#3b82f6"), rgb("#1e40af"), angle: 0deg),
    stroke: none,
    inset: (x: page-margin, y: 0pt),
  )[
    #set text(fill: white)
    #align(left + horizon)[
      #text(size: 24pt, weight: "bold")[#upper(name)]
      #if headline != "" [
        #linebreak()
        #v(0.25em)
        #text(size: 11.5pt)[#headline]
      ]
    ]
  ])
}
#v(band-height - page-margin + 0.45cm)

// ---- page 1: summary + sidebar -------------------------------------------
#let sidebar = block(width: 100%, fill: panel-grey, inset: 10pt, radius: 3pt)[
  #if picture-path != "" and picture-hidden == false [
    #align(center)[#image(picture-path, width: 3cm)]
    #v(0.5em)
  ]
  #for item in contact-items [
    #contact-row(item)
    #v(0.3em)
  ]
  #if location != "" [
    #contact-row((text: location, url: ""))
    #v(0.3em)
  ]
  #for item in profile-items {
    let label = {
      let u = item-text(item, "username")
      let n = item-text(item, "network")
      if u != "" { u } else { n }
    }
    contact-row((text: label, url: item-text(item, "url")))
    v(0.3em)
  }
  #if skill-groups.len() > 0 [
    #v(0.5em)
    #text(size: 10.5pt, weight: "bold", fill: navy)[#upper(title-for("skills", "Technical Expertise"))]
    #v(-0.45em)
    #line(length: 100%, stroke: 1.2pt + rule-blue)
    #v(0.2em)
    #for group in skill-groups [
      #text(size: 8.8pt, weight: "bold", fill: navy)[#underline(item-text(group, "name"))] \
      #text(size: 8.5pt, fill: muted)[#list-of(group.at("keywords", default: ())).join(", ")]
      #v(0.45em)
    ]
  ]
]

#grid(
  columns: (1fr, 5.4cm),
  column-gutter: 0.6cm,
  [
    #if summary != "" [
      #section-heading(title-for("summary", "Executive Profile"))
      #set par(justify: false, leading: 0.55em)
      #text(size: 9pt, fill: muted)[#markup-text(summary)]
    ]
    #for section in competency-sections [
      #section-heading(item-text(section, "title"))
      #competency-list(section)
    ]
  ],
  sidebar,
)

// ---- current role (boxed) + earlier experience (timeline) ----------------
#let boxed = experience.len() > 0 and is-current(experience.at(0))
#let rest = if boxed { experience.slice(1) } else { experience }

#if boxed [
  #v(0.6em)
  #section-heading(title-for("experience", "Current Role & Impact"))
  #current-role-box(experience.at(0))
]

#for section in impact-sections [
  #v(0.7em)
  #impact-strip(section)
]

#if rest.len() > 0 [
  #if boxed { pagebreak(weak: true) }
  #section-heading(if boxed { "Professional Experience" } else { title-for("experience", "Professional Experience") })
  #timeline(rest)
]

// ---- remaining sections as grey boxes ------------------------------------
#let entry-lines(entries) = for entry in entries {
  let title = item-text(entry, "title")
  let sub = item-text(entry, "subtitle")
  let date = item-text(entry, "date")
  block(below: 0.5em, breakable: false)[
    #text(weight: "bold")[#link-or-text(title, item-text(entry, "url"))]
    #if sub != "" [ – #sub]
    #if date != "" [ #h(1fr) #text(fill: muted, size: 8.5pt)[#date]]
    #{
      let bullets = bullets-of(entry)
      if bullets.len() > 0 { v(0.15em); list(..bullets) }
    }
  ]
}

#let extra-entries(key, fallback) = {
  let entries = list-of(source.at(key, default: ()))
  if entries.len() > 0 {
    v(0.9em)
    grey-box(title-for(key, fallback), entry-lines(entries))
  }
}

#for section in callout-sections [
  #v(0.9em)
  #callout-panel(section)
]
#for section in other-sections [
  #v(0.9em)
  #custom-box(section)
]

#extra-entries("education", "Education")
#extra-entries("certifications", "Certifications")
#extra-entries("projects", "Projects")
#extra-entries("awards", "Awards")
#extra-entries("publications", "Publications")
#extra-entries("volunteer", "Volunteer")
#extra-entries("references", "References")

#{
  let languages = list-of(source.at("languages", default: ()))
  if languages.len() > 0 {
    v(0.9em)
    grey-box(title-for("languages", "Languages"), languages.map(l => {
      let level = item-text(l, "fluency")
      [*#item-text(l, "language")*#if level != "" [ (#level)]]
    }).join(" · "))
  }
  let interests = list-of(source.at("interests", default: ()))
  if interests.len() > 0 {
    v(0.9em)
    grey-box(title-for("interests", "Interests"), interests.map(i => item-text(i, "name")).join(" · "))
  }
  if custom-field-items.len() > 0 {
    v(0.9em)
    grey-box(title-for("customFields", "Details"), custom-field-items.map(c => {
      let t = item-text(c, "title")
      [#if t != "" [*#t:* ]#link-or-text(item-text(c, "text"), item-text(c, "url"))]
    }).join(" · "))
  }
}
