import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / 'sound/engines'))
from fish_pacing import punctuation_pauses


class PacingTests(unittest.TestCase):
    def test_comma_and_sentence_end_have_distinct_pauses(self):
        self.assertEqual(punctuation_pauses('お兄ちゃん、気をつけてね。帰ったら話そう！'),
                         'お兄ちゃん、[short pause]気をつけてね。[pause]帰ったら話そう！')

    def test_directions_and_decimal_numbers_are_preserved(self):
        text = '[warm, affectionate tone]あと3.5時間だよ。大丈夫？'
        self.assertEqual(punctuation_pauses(text), '[warm, affectionate tone]あと3.5時間だよ。[pause]大丈夫？')

    def test_no_double_pause_or_trailing_pause_and_closing_quotes_stay_together(self):
        text = '「またね。」そう言った。 [pause]うん！'
        once = punctuation_pauses(text)
        self.assertEqual(once, '「またね。」[pause]そう言った。 [pause]うん！')
        self.assertEqual(punctuation_pauses(once), once)

    def test_original_words_and_marks_remain_unchanged(self):
        text = '本当！？それなら、ゆっくり…話そうね。'
        result = punctuation_pauses(text)
        self.assertEqual(result.replace('[short pause]', '').replace('[pause]', ''), text)


if __name__ == '__main__':
    unittest.main()
