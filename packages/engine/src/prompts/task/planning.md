<planning>
kind: {{kind}}
goal: {{goal}}
</planning>

{{preferences}}
<record>
{{record}}
</record>

<drafts>
{{drafts}}
</drafts>

<desk>
{{desk}}
</desk>

<recent_runs>
{{runs}}
</recent_runs>

<roles>
{{roles}}
</roles>

<retro>
{{retro}}
</retro>

<copy>
The base branch at {{commit}}, with the backlog, read-only at {{dir}}.
</copy>

<proposal_schema>
An edit or split may set an existing story's dependencies, as the whole list; never ask the maintainer to set dependencies by hand.
Each proposal is one ```{{fence}} block holding one JSON object that passes this JSON Schema:
{{schema}}
</proposal_schema>

<question_schema>
Each block of questions is one ```{{questions_fence}} block holding one JSON object that passes this JSON Schema:
{{questions_schema}}
</question_schema>
