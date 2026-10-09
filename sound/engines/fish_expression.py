"""Short synthesis-only directions; visible dialogue is kept intact."""
EXPRESSIONS = {'natural': '', 'warm': '[warm, affectionate tone]', 'lively': '[excited]'}


def expression_text(text, expression):
    if expression not in EXPRESSIONS:
        raise ValueError('Unknown Fish expression')
    prefix = EXPRESSIONS[expression]
    return prefix + text if prefix else text
