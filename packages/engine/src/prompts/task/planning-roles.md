<planning>
kind: {{kind}}
goal: {{goal}}
</planning>

{{preferences}}
<record>
{{record}}
</record>

<roles>
{{roles}}
</roles>

<invalid_roles>
{{invalid}}
</invalid_roles>

<copy>
The base branch at {{commit}}, with the backlog, read-only at {{dir}}.
</copy>

<proposal_schema>
This session takes only role proposals: a new role, a change to a role, the removal of a role. dipo refuses a proposal about a story.
Each proposal is one ```{{fence}} block holding one JSON object that passes this JSON Schema:
{{schema}}
</proposal_schema>

<question_schema>
Each block of questions is one ```{{questions_fence}} block holding one JSON object that passes this JSON Schema:
{{questions_schema}}
</question_schema>
