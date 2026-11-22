package io.github.tyanochkuby.uifixture;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.text.Editable;
import android.text.TextWatcher;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public class FixtureActivity extends Activity {
    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout screen = new LinearLayout(this);
        screen.setOrientation(LinearLayout.VERTICAL);

        EditText query = new EditText(this);
        query.setSingleLine();
        query.setHint("Search stations");
        screen.addView(query);

        Button result = new Button(this);
        result.setText("Central Station");
        result.setAllCaps(false);
        result.setEnabled(false);
        screen.addView(result);

        query.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {
                result.setEnabled("Central".contentEquals(text));
            }
            @Override public void afterTextChanged(Editable text) {}
        });

        result.setOnClickListener(view -> {
            TextView details = new TextView(this);
            details.setText("Destination: Central Station");
            screen.removeAllViews();
            screen.addView(details);
            Button leave = new Button(this);
            leave.setText("Open Settings");
            leave.setAllCaps(false);
            leave.setOnClickListener(button -> startActivity(new Intent(Settings.ACTION_SETTINGS)));
            screen.addView(leave);
        });
        setContentView(screen);
    }
}
